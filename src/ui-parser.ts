/**
 * Self-contained UI parser for the openrouter adapter.
 *
 * Translates the structured stdout JSON lines emitted by ./server/execute.ts
 * into Paperclip transcript entries. ZERO runtime imports — this module is
 * read as source and evaluated inside a browser sandbox, so it must have no
 * imports and no side effects.
 */
interface InitEntry {
  kind: "init";
  ts: string;
  model: string;
  sessionId: string;
}
interface AssistantEntry {
  kind: "assistant";
  ts: string;
  text: string;
}
interface SystemEntry {
  kind: "system";
  ts: string;
  text: string;
}
interface StderrEntry {
  kind: "stderr";
  ts: string;
  text: string;
}
interface StdoutEntry {
  kind: "stdout";
  ts: string;
  text: string;
}
interface ToolCallEntry {
  kind: "tool_call";
  ts: string;
  name: string;
  input: unknown;
  toolUseId: string;
}
interface ToolResultEntry {
  kind: "tool_result";
  ts: string;
  toolUseId: string;
  toolName: string;
  content: string;
  isError: boolean;
}
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
type TranscriptEntry =
  | InitEntry
  | AssistantEntry
  | SystemEntry
  | StderrEntry
  | StdoutEntry
  | ToolCallEntry
  | ToolResultEntry
  | ResultEntry;

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    if (line.startsWith("[paperclip]")) {
      return [{ kind: "system", ts, text: line.replace(/^\[paperclip\]\s*/, "") }];
    }
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "system" && asString(parsed.subtype) === "init") {
    return [{ kind: "init", ts, model: asString(parsed.model), sessionId: asString(parsed.runId) }];
  }

  if (type === "message") {
    const text = asString(parsed.text);
    if (!text) return [];
    return asString(parsed.role) === "assistant"
      ? [{ kind: "assistant", ts, text }]
      : [{ kind: "system", ts, text }];
  }

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

  if (type === "result") {
    const usage = asRecord(parsed.usage);
    const finishReason = asString(parsed.finishReason);
    const isError = parsed.isError === true;
    const elapsedMs = asNumber(parsed.elapsedMs, 0);
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
        inputTokens: asNumber(usage?.inputTokens, 0),
        outputTokens: asNumber(usage?.outputTokens, 0),
        cachedTokens: asNumber(usage?.cachedInputTokens, 0),
        costUsd: asNumber(parsed.costUsd, 0),
        subtype: finishReason || "completion",
        isError,
        errors: isError ? [summaryParts.join(" ")] : [],
      },
    ];
  }

  if (type === "error") {
    return [{ kind: "stderr", ts, text: asString(parsed.message, asString(parsed.error, line)) }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

function reset(): void {
  // Stateless parser.
}

export { parseLine as parseStdoutLine };
export function createStdoutParser(): { parseLine: typeof parseLine; reset: () => void } {
  return { parseLine, reset };
}
