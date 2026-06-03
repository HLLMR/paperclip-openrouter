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
  arguments: Record<string, unknown>;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUsage(record: Record<string, unknown>): UsageSummary | null {
  const usage = asRecord(record.usage);
  if (!usage) return null;
  const inputTokens =
    asNumber(usage.prompt_tokens) ?? asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens);
  const outputTokens =
    asNumber(usage.completion_tokens) ?? asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens);
  const cachedDetails = asRecord(usage.prompt_tokens_details);
  const cachedInputTokens =
    asNumber(usage.cached_tokens) ??
    asNumber(usage.cache_read_input_tokens) ??
    asNumber(usage.cachedInputTokens) ??
    asNumber(cachedDetails?.cached_tokens);
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

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

function readContentText(message: Record<string, unknown>): string {
  const direct = asString(message.content);
  if (direct) return direct;
  const arr = message.content;
  if (Array.isArray(arr)) {
    const parts: string[] = [];
    for (const item of arr) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      const rec = asRecord(item);
      if (!rec) continue;
      const text = asString(rec.text) ?? asString(rec.value);
      if (text) parts.push(text);
    }
    return parts.join("");
  }
  return "";
}

function readToolCalls(message: Record<string, unknown>): ParsedToolCall[] {
  const arr = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const out: ParsedToolCall[] = [];
  for (let i = 0; i < arr.length; i++) {
    const rec = asRecord(arr[i]);
    if (!rec) continue;
    const fn = asRecord(rec.function);
    const name = asString(fn?.name);
    if (!name) continue;
    const argumentsRaw = asString(fn?.arguments) ?? "";
    let parsed: Record<string, unknown> = {};
    if (argumentsRaw.trim().length > 0) {
      try {
        const candidate = JSON.parse(argumentsRaw);
        parsed = asRecord(candidate) ?? { _rawArguments: argumentsRaw };
      } catch {
        parsed = { _rawArguments: argumentsRaw };
      }
    }
    const id = asString(rec.id) ?? `call_${i}`;
    out.push({ id, name, arguments: parsed, argumentsRaw });
  }
  return out;
}

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
    assistant: { content: text, toolCalls },
  };
}

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
