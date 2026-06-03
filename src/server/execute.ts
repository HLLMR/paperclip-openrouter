/**
 * OpenRouter execution: an in-process, multi-turn tool loop.
 *
 * Each heartbeat assembles a prompt, POSTs to OpenRouter's chat-completions
 * endpoint with `usage: { include: true }`, runs any requested tools, and
 * loops until the model stops or maxToolTurns is hit. Conversation messages
 * are persisted in sessionParams so multi-turn work survives across wakes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  joinPromptSections,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_MAX_TOOL_TURNS,
  DEFAULT_MODEL,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_SESSION_MESSAGE_CAP,
  DEFAULT_TIMEOUT_SEC,
  type as ADAPTER_TYPE,
} from "../index.js";
import { isAuthError, isToolUseUnsupported, parseOpenRouterResponse } from "./parse.js";
import { builtinTools, findTool, toOpenRouterTools } from "./tools/index.js";
import type { ToolEnvironment } from "./tools/index.js";
import { buildRequestMessages, modelSupportsExplicitCache, type ChatMessage } from "./cache.js";
import { loadDesiredSkillsForRun, renderSkillsSection } from "./skills.js";

const DEFAULT_FS_MAX_BYTES = 256 * 1024;
const DEFAULT_SHELL_TIMEOUT_SEC = 60;
const REASONING_EFFORTS = new Set(["low", "medium", "high"]);

// Unwraps an env value that may be either a bare string or a Paperclip
// secret-shaped record (`{ type: "plain", value }`). Anything else (e.g. a
// reference to a secret store we can't read here) resolves to null and is skipped.
function resolveEnvValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (record && record.type === "plain" && typeof record.value === "string") return record.value;
  return null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(lower)) return true;
    if (["0", "false", "no", "n", "off"].includes(lower)) return false;
  }
  return fallback;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) out.push(entry.trim());
  }
  return out.length > 0 ? out : null;
}

function readOptionalNumber(value: unknown): number {
  return value !== undefined && value !== "" ? asNumber(value, NaN) : NaN;
}

// Rehydrates the persisted conversation from sessionParams back into typed
// ChatMessages. Hand-validates every field because the input is untrusted JSON
// from a prior run: only the four known roles survive, content is coerced to a
// string (or kept null for assistant tool-call turns), and tool_calls are
// rebuilt one by one, dropping any malformed entry and synthesizing an id when
// the model/provider omitted one (OpenRouter requires ids to pair tool results).
function readPriorMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const role = rec.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
    const message: ChatMessage = {
      role,
      content: typeof rec.content === "string" ? rec.content : rec.content === null ? null : "",
    };
    if (typeof rec.name === "string") message.name = rec.name;
    if (typeof rec.tool_call_id === "string") message.tool_call_id = rec.tool_call_id;
    if (Array.isArray(rec.tool_calls)) {
      const calls: NonNullable<ChatMessage["tool_calls"]> = [];
      for (const tc of rec.tool_calls) {
        if (typeof tc !== "object" || tc === null) continue;
        const tcRec = tc as Record<string, unknown>;
        const fn = tcRec.function as Record<string, unknown> | undefined;
        if (!fn || typeof fn.name !== "string") continue;
        calls.push({
          id: typeof tcRec.id === "string" ? tcRec.id : `call_${calls.length}`,
          type: "function",
          function: { name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : "" },
        });
      }
      if (calls.length > 0) message.tool_calls = calls;
    }
    out.push(message);
  }
  return out;
}

// Bounds the persisted history so sessions don't grow without limit across
// heartbeats. The first message (the system prompt) is always kept as the head
// and the most-recent messages fill the remaining budget — the middle is dropped.
function capMessages(messages: ChatMessage[], cap: number): ChatMessage[] {
  if (messages.length <= cap) return messages;
  const head = messages.slice(0, 1);
  const tail = messages.slice(-(cap - head.length));
  return [...head, ...tail];
}

// Accumulates per-request usage into a running total across all tool turns.
// cachedInputTokens is only emitted when non-zero to keep the summary clean for
// providers/models that don't report cache reads.
function mergeUsage(into: UsageSummary, add: UsageSummary | null): UsageSummary {
  if (!add) return into;
  const cached = (into.cachedInputTokens ?? 0) + (add.cachedInputTokens ?? 0);
  return {
    inputTokens: (into.inputTokens ?? 0) + (add.inputTokens ?? 0),
    outputTokens: (into.outputTokens ?? 0) + (add.outputTokens ?? 0),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

// Builds a short note injected into the user prompt telling the model which
// tools it can call this turn (or that it has none and must hand work back to
// the operator). Trailing blank lines give clean separation from the next section.
function renderToolCapabilityNote(toolNames: string[]): string {
  if (toolNames.length === 0) {
    return [
      "Paperclip tool note:",
      "No tools are enabled for this run. If your reply needs to take action, ask the operator to forward your output to a tool-capable executor.",
      "",
      "",
    ].join("\n");
  }
  return [
    "Paperclip tool-loop note:",
    `You have these tools available this turn: ${toolNames.join(", ")}.`,
    "Use paperclip_api_request for any Paperclip API call (checkout, comments, status updates). Authentication is automatic — do not pass tokens.",
    "",
    "",
  ].join("\n");
}

// Renders the "why was I woken" context block. Each fact (triggering task,
// wake reason, comment thread, linked issues, working dir) is only emitted when
// present, so the model gets a tight, relevant briefing instead of boilerplate.
// Notably it tells the model NOT to waste a tool call re-discovering an assigned
// issue when this wake already names it. Returns "" when there's nothing to say.
function renderWakeContextNote(input: {
  taskId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  linkedIssueIds: string[];
  workspaceCwd: string;
  workspaceSource: string;
}): string {
  const lines: string[] = [];
  if (input.taskId) {
    lines.push(`- This heartbeat was triggered for issue/task ${input.taskId}. Prioritize it first if it is assigned to you.`);
  }
  if (input.wakeReason) lines.push(`- Wake reason: ${input.wakeReason}.`);
  if (input.wakeReason === "issue_assigned") {
    lines.push("- Do not spend a tool call checking for assigned issues first; this wake already identifies the task.");
  }
  if (input.wakeCommentId) lines.push(`- Triggering comment id: ${input.wakeCommentId}. Read that comment thread first when relevant.`);
  if (input.linkedIssueIds.length > 0) lines.push(`- Linked issue ids: ${input.linkedIssueIds.join(", ")}.`);
  if (input.workspaceCwd) lines.push(`- Working directory for this run: ${input.workspaceCwd}.`);
  if (input.workspaceSource) lines.push(`- Workspace source: ${input.workspaceSource}.`);
  if (lines.length === 0) return "";
  return ["Paperclip wake context:", ...lines, "", ""].join("\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;

  // --- Config resolution: model, sampling, endpoint, and caching toggles ---
  // All values come from adapter config with typed coercion + defaults. Prompt
  // caching is only used when not explicitly disabled AND the model family
  // supports explicit cache_control breakpoints (Anthropic/Gemini on OpenRouter).
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const apiBaseUrl = (asString(config.apiBaseUrl, DEFAULT_OPENROUTER_BASE_URL) || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, "");
  const model = (asString(config.model, DEFAULT_MODEL) || DEFAULT_MODEL).trim();
  const temperature = readOptionalNumber(config.temperature);
  const topP = readOptionalNumber(config.topP);
  const maxTokens = readOptionalNumber(config.maxTokens);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const systemPromptOverride = asString(config.systemPrompt, "").trim();
  const siteUrl = asString(config.siteUrl, "").trim();
  const siteTitle = asString(config.siteTitle, "Paperclip").trim();
  const providerSlug = asString(config.providerSlug, "").trim();
  // Accept either our explicit `reasoningEffort` or Paperclip's generic
  // "Thinking effort" UI field (`thinkingEffort`) — the built-in adapters use
  // the latter, so this honors the dropdown shown in the agent config UI.
  const reasoningEffort = (asString(config.reasoningEffort, "") || asString(config.thinkingEffort, ""))
    .trim()
    .toLowerCase();
  const promptCachingDisabled = readBoolean(config.disablePromptCaching, false);
  const useCacheControl = !promptCachingDisabled && modelSupportsExplicitCache(model);

  // --- Tool + loop limits ---
  // Shell and fs tools are opt-in and sandboxed (allow-lists, byte/time caps).
  // maxToolTurns and sessionMessageCap are clamped to sane hard bounds so config
  // can't request an unbounded loop or an unbounded persisted transcript.
  const toolsConfig = parseObject(config.tools);
  const shellConfig = parseObject(toolsConfig.shell);
  const fsConfig = parseObject(toolsConfig.fs);
  const shellEnabled = readBoolean(shellConfig.enabled, false);
  const shellAllowList = readStringArray(shellConfig.allowList);
  const fsAllowOutsideCwd = readBoolean(fsConfig.allowOutsideCwd, false);
  const fsMaxBytes = Math.max(1024, asNumber(fsConfig.maxBytes, DEFAULT_FS_MAX_BYTES));
  const shellTimeoutSec = Math.max(1, Math.min(600, asNumber(shellConfig.timeoutSec, DEFAULT_SHELL_TIMEOUT_SEC)));
  const maxToolTurns = Math.max(1, Math.min(40, asNumber(config.maxToolTurns, DEFAULT_MAX_TOOL_TURNS)));
  const sessionMessageCap = Math.max(4, Math.min(200, asNumber(config.sessionMessageCap, DEFAULT_SESSION_MESSAGE_CAP)));

  // --- Resolve the working directory ---
  // Precedence: an explicitly configured cwd overrides the agent_home workspace
  // (the operator pinned a dir), otherwise the workspace cwd wins, then the
  // configured cwd, then the process cwd. The chosen dir is created if missing.
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // --- Build the tool/process environment ---
  // Start from the standard Paperclip env, then layer in wake-context vars so
  // tools (and any spawned shells) can see the triggering task/comment/issue ids
  // and workspace. Config-provided env is resolved/merged last so it can override.
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0 ? context.wakeReason.trim() : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  for (const [key, value] of Object.entries(envConfig)) {
    const resolved = resolveEnvValue(value);
    if (resolved !== null) env[key] = resolved;
  }

  // --- Credentials ---
  // OpenRouter key may come from config or the (already-merged) env. The
  // Paperclip API url/key let the paperclip_api_request tool call back into
  // Paperclip; the API key falls back to the run's auth token.
  const configApiKey = asString(config.apiKey, "").trim();
  const envApiKey = (env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "").trim();
  const apiKey = configApiKey || envApiKey;
  const paperclipApiUrl = (env.PAPERCLIP_API_URL ?? process.env.PAPERCLIP_API_URL ?? "").trim() || null;
  const paperclipApiKey = (env.PAPERCLIP_API_KEY ?? ctx.authToken ?? "").trim() || null;

  // --- Tool wiring ---
  // toolEnvironment is the sandbox/context every tool invocation receives.
  // enabledTools is the subset whose preconditions are met (used for the prompt
  // note and availability checks); openRouterTools is the JSON schema list sent
  // to the model so it knows what it can call.
  const toolEnvironment: ToolEnvironment = {
    cwd,
    agent,
    runId,
    paperclipApiUrl,
    paperclipApiKey,
    shellEnabled,
    shellAllowList,
    fsAllowOutsideCwd,
    shellTimeoutSec,
    fsMaxBytes,
    env,
  };
  const enabledTools = builtinTools.filter((t) => t.enabled(toolEnvironment));
  const openRouterTools = toOpenRouterTools(builtinTools, toolEnvironment);

  // Instructions file (optional, prepended to the system prompt).
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
  const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const contents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.`;
    } catch (err) {
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // --- Render prompt templates ---
  // The main prompt, an optional bootstrap prompt, and the session handoff note
  // are all rendered from config/context with the same template data bag.
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const renderedBootstrapPrompt =
    bootstrapPromptTemplate.trim().length > 0 ? renderTemplate(bootstrapPromptTemplate, templateData).trim() : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  // --- Assemble the system and user prompts ---
  // System = optional override + instructions file. The user message stitches
  // together, IN THIS DELIBERATE ORDER: bootstrap prompt, session handoff note,
  // wake context, tool-capability note, then the rendered task prompt. Ordering
  // matters — context-setting framing comes first, the actual ask comes last.
  // Ephemeral skills: read the agent's selected company skills and inject their
  // markdown as a `## Skills` section. Lands in the cached system prefix for
  // Anthropic/Gemini, so the skill tokens are paid once per cache window.
  const skillsSection = renderSkillsSection(await loadDesiredSkillsForRun(config));
  const systemContent = joinPromptSections(
    [systemPromptOverride, skillsSection, instructionsPrefix].filter((s) => s && s.trim().length > 0),
  );
  const userContent = joinPromptSections([
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderWakeContextNote({
      taskId: wakeTaskId,
      wakeReason,
      wakeCommentId,
      linkedIssueIds,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
    }),
    renderToolCapabilityNote(enabledTools.map((t) => t.name)),
    renderedPrompt,
  ]);

  // --- Session resume vs. fresh start ---
  // If a prior transcript exists (a resumed session), replay it and append only
  // this heartbeat's freshly-built user message — the system prompt and earlier
  // turns are already in the persisted history. On a cold start, seed the system
  // prompt (when non-empty) followed by the user message.
  const priorMessages = readPriorMessages((runtime.sessionParams as Record<string, unknown> | null)?.messages);
  const messages: ChatMessage[] = [];
  if (priorMessages.length === 0) {
    if (systemContent.trim().length > 0) messages.push({ role: "system", content: systemContent });
    messages.push({ role: "user", content: userContent });
  } else {
    messages.push(...priorMessages, { role: "user", content: userContent });
  }

  // --- Report planned command + prompt metrics to Paperclip (pre-flight) ---
  // Surfaces what we're about to do (endpoint, model, tool set, turn cap,
  // caching) plus prompt-size metrics for observability before any request runs.
  if (onMeta) {
    await onMeta({
      adapterType: ADAPTER_TYPE,
      command: `${apiBaseUrl}/chat/completions`,
      cwd,
      commandNotes: [
        `POST ${apiBaseUrl}/chat/completions (model=${model}, messages=${messages.length}).`,
        `Adapter: paperclip-openrouter (multi-turn tool loop; ${enabledTools.length} tool(s) enabled).`,
        `Tools: ${enabledTools.map((t) => t.name).join(", ") || "(none)"}.`,
        `Max tool turns: ${maxToolTurns}.`,
        ...(reasoningEffort && REASONING_EFFORTS.has(reasoningEffort) ? [`Reasoning effort: ${reasoningEffort}.`] : []),
        ...(useCacheControl ? ["Prompt caching: cache_control breakpoints enabled (Anthropic/Gemini)."] : []),
      ],
      commandArgs: ["POST", "/chat/completions", `model=${model}`],
      env: redactEnvForLogs(env),
      prompt: userContent,
      promptMetrics: {
        systemPromptChars: systemContent.length,
        userPromptChars: userContent.length,
        instructionsChars: instructionsPrefix.length,
        priorMessages: priorMessages.length,
        enabledTools: enabledTools.length,
      },
      context,
    });
  }

  // --- Hard precondition: API key must be present ---
  // Fail fast with a typed error result (and zeroed billing) rather than making
  // a doomed request. Billing fields are still populated so the run is attributed.
  if (!apiKey) {
    const message = "OpenRouter API key is not configured.";
    await onLog("stderr", `[paperclip] ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "openrouter_missing_api_key",
      provider: "openrouter",
      biller: "openrouter",
      model,
      billingType: "credits",
    };
  }

  // --- Static request headers ---
  // OpenRouter uses X-Title / HTTP-Referer for attribution on its dashboards.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-Title": siteTitle || "Paperclip OpenRouter Adapter",
  };
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;

  const overallStartedAt = Date.now();
  await onLog("stdout", JSON.stringify({ type: "system", subtype: "init", ts: nowIso(), model, runId }) + "\n");

  // --- Loop-scoped accumulators ---
  // These survive across tool turns: running usage/cost, the latest session id
  // and model echoed back by OpenRouter, the last finish reason, the final
  // assistant text, and whether we've fallen back to a tools-disabled retry.
  let totalUsage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
  let totalCostUsd = 0;
  let lastSessionId =
    typeof (runtime.sessionParams as Record<string, unknown> | null)?.sessionId === "string"
      ? ((runtime.sessionParams as Record<string, unknown>).sessionId as string)
      : null;
  let lastModel = model;
  let lastFinishReason: string | null = null;
  let finalAssistantText = "";
  let toolsDisabled = false;

  // Shapes a failure return value while preserving the usage/cost accumulated so
  // far and the standard billing attribution. Callers supply only the
  // error-specific fields; everything else is filled in consistently.
  const errorResult = (
    partial: Pick<AdapterExecutionResult, "exitCode" | "timedOut" | "errorMessage" | "errorCode">,
  ): AdapterExecutionResult => ({
    signal: null,
    provider: "openrouter",
    biller: "openrouter",
    model,
    billingType: "credits",
    usage: totalUsage,
    costUsd: totalCostUsd || null,
    ...partial,
  });

  // ===== Multi-turn tool loop =====
  // Each iteration is one round-trip to the model. We stop early when the model
  // returns no tool calls (it's done), or bail at maxToolTurns.
  for (let turn = 0; turn < maxToolTurns; turn++) {
    // Build the request. buildRequestMessages applies cache_control breakpoints
    // when caching is enabled; usage.include asks OpenRouter to return token/cost.
    const requestBody: Record<string, unknown> = {
      model,
      messages: buildRequestMessages(messages, model, useCacheControl),
      usage: { include: true },
    };
    if (Number.isFinite(temperature)) requestBody.temperature = temperature;
    if (Number.isFinite(topP)) requestBody.top_p = topP;
    if (Number.isFinite(maxTokens) && maxTokens > 0) requestBody.max_tokens = maxTokens;
    if (providerSlug) requestBody.provider = { order: [providerSlug] };
    if (reasoningEffort && REASONING_EFFORTS.has(reasoningEffort)) requestBody.reasoning = { effort: reasoningEffort };
    // Advertise tools unless we've already learned this model rejects tool use
    // (see the toolsDisabled fallback below), and only if any tools exist.
    if (!toolsDisabled && openRouterTools.length > 0) {
      requestBody.tools = openRouterTools;
      requestBody.tool_choice = "auto";
    }

    // Per-request timeout via AbortController (min 5s floor).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutSec, 5) * 1000);
    let res: Response;
    try {
      res = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      // Network-level failure or timeout. Distinguish an abort (our timeout) so
      // we can report exit 124 / timedOut and a dedicated error code.
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : "OpenRouter request failed";
      const aborted = err instanceof Error && (err.name === "AbortError" || /aborted/i.test(message));
      await onLog("stderr", `[paperclip] OpenRouter fetch failed (turn ${turn + 1}): ${message}\n`);
      return errorResult({
        exitCode: aborted ? 124 : 1,
        timedOut: aborted,
        errorMessage: aborted ? `Timed out after ${timeoutSec}s` : message,
        errorCode: aborted ? "openrouter_timeout" : "openrouter_request_failed",
      });
    }
    clearTimeout(timer);

    const bodyText = await res.text();
    if (!res.ok) {
      // Tool-use-unsupported fallback: some models 4xx specifically because the
      // request carried a tools array. Flip toolsDisabled and retry the SAME turn
      // without tools (continue, not return) — this turn isn't counted as wasted.
      if (!toolsDisabled && isToolUseUnsupported(res.status, bodyText)) {
        toolsDisabled = true;
        await onLog("stdout", "[paperclip] Model does not support tool use — retrying without tools.\n");
        continue;
      }
      // Any other HTTP error is terminal; classify auth errors for a distinct code.
      const auth = isAuthError(res.status, bodyText);
      await onLog("stderr", `[paperclip] OpenRouter ${res.status} ${res.statusText} (turn ${turn + 1}): ${bodyText.slice(0, 1000)}\n`);
      return errorResult({
        exitCode: 1,
        timedOut: false,
        errorMessage: `OpenRouter error ${res.status}: ${bodyText.slice(0, 240)}`,
        errorCode: auth ? "openrouter_auth_required" : "openrouter_http_error",
      });
    }

    // Parse the success body into a normalized shape (assistant text/tool calls,
    // usage, cost, id, model, finish reason). Malformed JSON is terminal.
    let parsed;
    try {
      parsed = parseOpenRouterResponse(JSON.parse(bodyText));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid JSON from OpenRouter";
      await onLog("stderr", `[paperclip] ${message}\n`);
      return errorResult({
        exitCode: 1,
        timedOut: false,
        errorMessage: message,
        errorCode: "openrouter_invalid_response",
      });
    }

    // Accumulate usage/cost and remember the latest session id / resolved model
    // (OpenRouter may route ":auto" or aliases to a concrete model) and finish reason.
    totalUsage = mergeUsage(totalUsage, parsed.usage);
    if (parsed.costUsd && Number.isFinite(parsed.costUsd)) totalCostUsd += parsed.costUsd;
    if (parsed.id) lastSessionId = parsed.id;
    if (parsed.model) lastModel = parsed.model;
    lastFinishReason = parsed.finishReason;

    // Append the assistant turn to history. content is null when the model only
    // emitted tool calls; tool_calls are re-serialized (preferring the raw
    // argument string) so they round-trip back to OpenRouter on the next request.
    const assistantText = parsed.assistant.content ?? "";
    const toolCalls = parsed.assistant.toolCalls;
    const assistantMessage: ChatMessage = { role: "assistant", content: assistantText || null };
    if (toolCalls.length > 0) {
      assistantMessage.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argumentsRaw || JSON.stringify(tc.arguments ?? {}) },
      }));
    }
    messages.push(assistantMessage);

    if (assistantText.trim().length > 0) {
      await onLog("stdout", JSON.stringify({ type: "message", role: "assistant", ts: nowIso(), text: assistantText }) + "\n");
    }

    // No tool calls => the model is finished. Capture its final text and exit.
    if (toolCalls.length === 0) {
      finalAssistantText = assistantText;
      break;
    }

    // --- Execute each requested tool call and feed results back as tool messages ---
    for (const call of toolCalls) {
      await onLog("stdout", JSON.stringify({ type: "tool_call", ts: nowIso(), name: call.name, input: call.arguments, toolUseId: call.id }) + "\n");
      const tool = findTool(builtinTools, call.name);
      let content: string;
      let isError: boolean;
      // Errors are shaped into the tool RESULT content (not thrown) so the model
      // sees what went wrong and can recover on the next turn. Three cases:
      // unknown/disabled tool, a tool that signals failure (isError/ok=false),
      // and a thrown exception during invocation.
      if (!tool || !tool.enabled(toolEnvironment)) {
        content = `tool ${call.name} is not available; enabled tools: ${enabledTools.map((t) => t.name).join(", ") || "(none)"}`;
        isError = true;
      } else {
        try {
          const r = await tool.invoke(call.arguments, toolEnvironment);
          content = r.content;
          isError = r.isError === true || r.ok === false;
        } catch (err) {
          content = err instanceof Error ? err.message : String(err);
          isError = true;
        }
      }
      await onLog("stdout", JSON.stringify({ type: "tool_result", ts: nowIso(), toolUseId: call.id, toolName: call.name, content, isError }) + "\n");
      // The tool_call_id pairs this result with the assistant's call so the next
      // request is well-formed; loop continues to give the model the results.
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
    }
  }

  // ===== Wrap up =====
  // We "ran out of turns" only if the loop exited via maxToolTurns without ever
  // landing a final assistant message (i.e. last response wasn't a clean stop and
  // we captured no final text) — that's treated as a failure below.
  const ranOutOfTurns = lastFinishReason !== "stop" && finalAssistantText === "";
  const summary = (finalAssistantText || "").trim();
  // Emit a terminal result event with elapsed time and aggregated usage/cost.
  await onLog(
    "stdout",
    JSON.stringify({
      type: "result",
      ts: nowIso(),
      model: lastModel ?? model,
      finishReason: lastFinishReason,
      elapsedMs: Date.now() - overallStartedAt,
      usage: totalUsage,
      costUsd: totalCostUsd || null,
      isError: ranOutOfTurns,
      ...(ranOutOfTurns ? { errors: [`Hit maxToolTurns (${maxToolTurns}) without a final assistant message.`] } : {}),
    }) + "\n",
  );

  // --- Persist session for the next heartbeat ---
  // Cap the transcript, then persist it under sessionParams so the next wake can
  // resume the conversation. Only persisted when we have a session id to key on;
  // otherwise sessionParams is null and the next run starts cold.
  const cappedMessages = capMessages(messages, sessionMessageCap);
  const sessionParams = lastSessionId
    ? { sessionId: lastSessionId, model: lastModel ?? model, messages: cappedMessages }
    : null;

  // --- Final result back to Paperclip ---
  // Exit code + error fields reflect the maxToolTurns-exhaustion case; usage,
  // cost, model, billing attribution, and the summary (final assistant text) are
  // always reported. sessionId/sessionParams enable resume.
  return {
    exitCode: ranOutOfTurns ? 1 : 0,
    signal: null,
    timedOut: false,
    errorMessage: ranOutOfTurns ? `Hit maxToolTurns (${maxToolTurns}) without a final assistant message.` : null,
    errorCode: ranOutOfTurns ? "openrouter_tool_loop_exhausted" : null,
    sessionId: lastSessionId,
    sessionParams,
    sessionDisplayId: lastSessionId,
    provider: "openrouter",
    biller: "openrouter",
    model: lastModel ?? model,
    billingType: "credits",
    usage: totalUsage,
    costUsd: totalCostUsd || null,
    summary: summary || null,
  };
}
