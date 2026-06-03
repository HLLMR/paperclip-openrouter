/**
 * OpenRouter chat-completions response parsing.
 *
 * Tolerant of the OpenAI-compatible shape OpenRouter returns, including the
 * `usage` block emitted when the request sets `usage: { include: true }`.
 */
import type { UsageSummary } from "@paperclipai/adapter-utils";

export interface ParsedToolCall {
  id: string;
  name: string;
  // Parsed argument object. When the raw JSON is invalid, this holds
  // `{ _rawArguments: <string> }` so the original is never lost.
  arguments: Record<string, unknown>;
  // The unmodified argument string as sent by the model, retained for logging
  // and as the source-of-truth when `arguments` could not be parsed.
  argumentsRaw: string;
}

export interface ParsedOpenRouterResponse {
  id: string | null;
  model: string | null;
  text: string;
  finishReason: string | null;
  usage: UsageSummary | null;
  costUsd: number | null;
  assistant: {
    content: string;
    toolCalls: ParsedToolCall[];
  };
}

// Narrow to a plain object (excluding arrays and null) for safe field access on
// untyped JSON. Returns null for anything else.
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Non-empty string or null. Note: unlike the models.ts helper, this returns the
// original (untrimmed) string — trimming is only used to reject blank values,
// since assistant text may rely on its leading/trailing whitespace.
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// Finite number or null; rejects NaN/Infinity so token/cost math stays sane.
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Extract token usage. OpenRouter proxies many upstream providers, each of
// which may use a different naming convention, so every field is tried under
// its OpenAI (snake_case), generic, and camelCase variants in priority order.
function readUsage(record: Record<string, unknown>): UsageSummary | null {
  const usage = asRecord(record.usage);
  if (!usage) return null;
  const inputTokens =
    asNumber(usage.prompt_tokens) ?? asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens);
  const outputTokens =
    asNumber(usage.completion_tokens) ?? asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens);
  // Prompt-cache hits can be reported either as a top-level field or nested
  // under `prompt_tokens_details` (OpenAI's newer shape).
  const cachedDetails = asRecord(usage.prompt_tokens_details);
  const cachedInputTokens =
    asNumber(usage.cached_tokens) ??
    asNumber(usage.cache_read_input_tokens) ??
    asNumber(usage.cachedInputTokens) ??
    asNumber(cachedDetails?.cached_tokens);
  // If none of the token fields were present, treat usage as absent rather than
  // reporting a misleading all-zero summary.
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    // Only include the cached field when actually reported, so consumers can
    // distinguish "no caching" from "zero cache hits".
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

// Per-call cost in USD. OpenRouter has reported this in several places across
// API versions — at the top level (`total_cost`/`totalCost`) and inside the
// usage block (`cost`/`total_cost`) — so probe all of them in turn.
function readCostUsd(record: Record<string, unknown>): number | null {
  const usage = asRecord(record.usage);
  return (
    asNumber(record.total_cost) ??
    asNumber(record.totalCost) ??
    asNumber(usage?.cost) ??
    asNumber(usage?.total_cost) ??
    null
  );
}

// Flatten assistant message content into a single string. `content` may be a
// plain string (common case) or an array of content parts (multimodal/newer
// shape); for arrays we concatenate the text of each part and ignore non-text
// parts (e.g. images).
function readContentText(message: Record<string, unknown>): string {
  const direct = asString(message.content);
  if (direct) return direct;
  const arr = message.content;
  if (Array.isArray(arr)) {
    const parts: string[] = [];
    for (const item of arr) {
      // A part may itself be a bare string or an object carrying the text under
      // `text` (OpenAI) or `value` (some providers).
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      const rec = asRecord(item);
      if (!rec) continue;
      const text = asString(rec.text) ?? asString(rec.value);
      if (text) parts.push(text);
    }
    // Join without a separator: parts are contiguous fragments of one message.
    return parts.join("");
  }
  return "";
}

// Extract tool/function calls from the assistant message. Skips malformed
// entries (non-objects or calls with no function name) rather than failing the
// whole parse.
function readToolCalls(message: Record<string, unknown>): ParsedToolCall[] {
  const arr = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const out: ParsedToolCall[] = [];
  for (let i = 0; i < arr.length; i++) {
    const rec = asRecord(arr[i]);
    if (!rec) continue;
    const fn = asRecord(rec.function);
    const name = asString(fn?.name);
    if (!name) continue;
    // The API delivers arguments as a JSON-encoded string. Default empty so a
    // missing/blank value yields an empty `{}` argument object.
    const argumentsRaw = asString(fn?.arguments) ?? "";
    let parsed: Record<string, unknown> = {};
    if (argumentsRaw.trim().length > 0) {
      try {
        // Models occasionally emit invalid JSON or a non-object (array/scalar).
        // In both cases we fall back to preserving the raw string under
        // `_rawArguments` so the caller can still recover or surface it.
        const candidate = JSON.parse(argumentsRaw);
        parsed = asRecord(candidate) ?? { _rawArguments: argumentsRaw };
      } catch {
        parsed = { _rawArguments: argumentsRaw };
      }
    }
    // Synthesize a stable id when the provider omits one, so each call in the
    // batch remains addressable.
    const id = asString(rec.id) ?? `call_${i}`;
    out.push({ id, name, arguments: parsed, argumentsRaw });
  }
  return out;
}

// Top-level parser: turn an untyped chat-completions response into the strongly
// typed shape the adapter works with. Never throws — a malformed or non-object
// input yields the empty `fallback` so callers always get a usable result.
export function parseOpenRouterResponse(value: unknown): ParsedOpenRouterResponse {
  const record = asRecord(value);
  const fallback: ParsedOpenRouterResponse = {
    id: null,
    model: null,
    text: "",
    finishReason: null,
    usage: null,
    costUsd: null,
    assistant: { content: "", toolCalls: [] },
  };
  if (!record) return fallback;
  const id = asString(record.id);
  const model = asString(record.model);
  // We only consume the first choice; the adapter never requests n > 1.
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = firstChoice ? asRecord(firstChoice.message) : null;
  const text = message ? readContentText(message) : "";
  const toolCalls = message ? readToolCalls(message) : [];
  const finishReason = firstChoice ? asString(firstChoice.finish_reason) : null;
  return {
    id,
    model,
    text,
    finishReason,
    usage: readUsage(record),
    costUsd: readCostUsd(record),
    // `assistant.content` mirrors `text`; the nested shape groups the parsed
    // assistant turn (text + tool calls) for consumers that want it together.
    assistant: { content: text, toolCalls },
  };
}

// Classify a failed request as an auth problem. 401/403 are unambiguous; the
// substring checks catch providers that return auth failures under other
// status codes (e.g. 400/500) but describe the cause in the body.
export function isAuthError(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes("invalid api key") ||
    lower.includes("authentication failed") ||
    lower.includes("missing credentials") ||
    lower.includes("no auth credentials")
  );
}

// Detect "this model/endpoint can't do tool calls" errors so the caller can
// retry without tools or pick another model. Status is ignored (hence `_`) —
// only the error text reliably signals this across OpenRouter's many upstreams,
// which phrase it inconsistently (hence the several variants below).
export function isToolUseUnsupported(_status: number, body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("no endpoints found that support tool use") ||
    lower.includes("does not support tools") ||
    lower.includes("tool_use is not supported") ||
    lower.includes("tools are not supported") ||
    lower.includes("no endpoints found that support tool")
  );
}
