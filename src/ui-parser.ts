/**
 * Self-contained UI parser for the openrouter adapter.
 *
 * Translates the structured stdout JSON lines emitted by ./server/execute.ts
 * into Paperclip transcript entries. ZERO runtime imports — this module is
 * read as source and evaluated inside a browser sandbox, so it must have no
 * imports and no side effects.
 *
 * WHY import-free / side-effect-free: Paperclip ships this file's source text
 * to the client and runs it inside a locked-down browser sandbox to render a
 * run's transcript. There is no module loader and no Node/DOM available there,
 * so any `import`, top-level statement, or global access would throw at eval
 * time. Everything this parser needs is therefore defined inline below, and the
 * type-only interfaces above compile away to nothing in the emitted JS.
 *
 * Contract: the producer (execute.ts) writes one JSON object per stdout line
 * tagged with a `type` field; `parseLine` maps each `type` to one (or zero, or
 * several) typed TranscriptEntry records the Paperclip UI knows how to render.
 */
// --- TranscriptEntry variants (the shapes the Paperclip UI renders) ---
// `kind` is the discriminant; `ts` is the line's timestamp on every variant.

// Run header: model name + session/run id, emitted once at startup.
interface InitEntry {
  kind: "init";
  ts: string;
  model: string;
  sessionId: string;
}
// Assistant (model) message text.
interface AssistantEntry {
  kind: "assistant";
  ts: string;
  text: string;
}
// System/non-assistant message, or a `[paperclip]` annotation line.
interface SystemEntry {
  kind: "system";
  ts: string;
  text: string;
}
// Error channel — model `type: "error"` events surface here.
interface StderrEntry {
  kind: "stderr";
  ts: string;
  text: string;
}
// Fallback bucket for unrecognized / non-JSON stdout lines (raw passthrough).
interface StdoutEntry {
  kind: "stdout";
  ts: string;
  text: string;
}
// A tool invocation. `toolUseId` correlates this call with its later result.
interface ToolCallEntry {
  kind: "tool_call";
  ts: string;
  name: string;
  input: unknown;
  toolUseId: string;
}
// The result of a tool call, matched back to the call via `toolUseId`.
interface ToolResultEntry {
  kind: "tool_result";
  ts: string;
  toolUseId: string;
  toolName: string;
  content: string;
  isError: boolean;
}
// Terminal summary of the completion: token usage, cost, finish reason.
interface ResultEntry {
  kind: "result";
  ts: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  subtype: string;
  isError: boolean;
  errors: string[];
}
// Discriminated union of every entry the parser can emit.
type TranscriptEntry =
  | InitEntry
  | AssistantEntry
  | SystemEntry
  | StderrEntry
  | StdoutEntry
  | ToolCallEntry
  | ToolResultEntry
  | ResultEntry;

// --- Defensive coercion helpers ---
// Input lines are untrusted text; these helpers never throw and always yield a
// well-typed value, so a single malformed line can't break the whole render.

// JSON.parse that returns null instead of throwing on invalid JSON.
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Narrow to a plain object; arrays and non-objects become null (so callers can
// treat "not a JSON object" uniformly).
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Read a string field, substituting `fallback` for anything non-string.
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// Read a finite number field, substituting `fallback` for NaN/Infinity/non-num.
function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Map one raw stdout line to zero-or-more transcript entries.
// Returns an array (not a single entry) so a line can expand to several or be
// dropped entirely (empty array). `ts` is supplied by the caller, not parsed.
function parseLine(line: string, ts: string): TranscriptEntry[] {
  // Non-JSON line: either a human `[paperclip]` annotation (strip the prefix
  // and show as system) or raw output we pass through verbatim as stdout.
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    if (line.startsWith("[paperclip]")) {
      return [{ kind: "system", ts, text: line.replace(/^\[paperclip\]\s*/, "") }];
    }
    return [{ kind: "stdout", ts, text: line }];
  }

  // Dispatch on the producer's `type` tag. Unknown types fall through to the
  // raw-stdout fallback at the bottom.
  const type = asString(parsed.type);

  // system/init -> run header. Note `runId` is mapped onto `sessionId`.
  if (type === "system" && asString(parsed.subtype) === "init") {
    return [{ kind: "init", ts, model: asString(parsed.model), sessionId: asString(parsed.runId) }];
  }

  // message -> assistant vs system, keyed off `role`. Empty text is dropped
  // (return []) so blank deltas don't clutter the transcript.
  if (type === "message") {
    const text = asString(parsed.text);
    if (!text) return [];
    return asString(parsed.role) === "assistant"
      ? [{ kind: "assistant", ts, text }]
      : [{ kind: "system", ts, text }];
  }

  // tool_call -> a tool invocation; `input` is passed through untyped (unknown)
  // since each tool's schema differs and the UI renders it generically.
  if (type === "tool_call") {
    return [
      {
        kind: "tool_call",
        ts,
        name: asString(parsed.name),
        input: parsed.input,
        toolUseId: asString(parsed.toolUseId),
      },
    ];
  }

  // tool_result -> outcome of a call; `toolUseId` links it to its tool_call.
  // `isError` uses a strict `=== true` so a missing/garbage flag reads as false.
  if (type === "tool_result") {
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: asString(parsed.toolUseId),
        toolName: asString(parsed.toolName),
        content: asString(parsed.content),
        isError: parsed.isError === true,
      },
    ];
  }

  // result -> terminal completion summary. The producer sends structured usage
  // metrics; here we also synthesize a human-readable one-line summary string.
  if (type === "result") {
    const usage = asRecord(parsed.usage);
    const finishReason = asString(parsed.finishReason);
    const isError = parsed.isError === true;
    const elapsedMs = asNumber(parsed.elapsedMs, 0);
    // Build the summary from parts, dropping empty pieces with filter(Boolean)
    // so we don't emit dangling "finish_reason=" / "elapsed=" fragments.
    const summaryParts = [
      `OpenRouter completion finished${isError ? " with error" : ""}.`,
      finishReason ? `finish_reason=${finishReason}` : "",
      elapsedMs > 0 ? `elapsed=${elapsedMs}ms` : "",
    ].filter(Boolean);
    return [
      {
        kind: "result",
        ts,
        text: summaryParts.join(" "),
        // Usage fields are read defensively from the nested `usage` object;
        // note the wire name `cachedInputTokens` maps to UI `cachedTokens`.
        inputTokens: asNumber(usage?.inputTokens, 0),
        outputTokens: asNumber(usage?.outputTokens, 0),
        cachedTokens: asNumber(usage?.cachedInputTokens, 0),
        costUsd: asNumber(parsed.costUsd, 0),
        // Default the subtype label to "completion" when no finish reason given.
        subtype: finishReason || "completion",
        isError,
        // Populate `errors` only on failure (the UI shows it as an error list).
        errors: isError ? [summaryParts.join(" ")] : [],
      },
    ];
  }

  // error -> stderr channel. Prefer `message`, then `error`, then the raw line.
  if (type === "error") {
    return [{ kind: "stderr", ts, text: asString(parsed.message, asString(parsed.error, line)) }];
  }

  // Recognized JSON object but unknown `type`: keep the raw line as stdout
  // rather than silently dropping it (helps debugging new producer output).
  return [{ kind: "stdout", ts, text: line }];
}

// No-op: the parser holds no cross-line state, so reset has nothing to clear.
// Kept to satisfy the parser interface Paperclip expects.
function reset(): void {
  // Stateless parser.
}

// Public surface: a bare `parseStdoutLine`, plus a factory returning the same
// stateless functions bundled as the {parseLine, reset} shape Paperclip wires up.
export { parseLine as parseStdoutLine };
export function createStdoutParser(): { parseLine: typeof parseLine; reset: () => void } {
  return { parseLine, reset };
}
