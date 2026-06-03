/**
 * Anthropic / Gemini prompt caching over OpenRouter.
 *
 * OpenRouter passes `cache_control` breakpoints through to providers that need
 * them explicitly (Anthropic Claude, Google Gemini). OpenAI / Grok / DeepSeek
 * cache automatically and ignore the field, so we only rewrite messages for the
 * providers that benefit — leaving everyone else as plain strings.
 *
 * We place up to two breakpoints per request (Anthropic allows four):
 *   1. the system message — caches the large, stable system + tool-schema prefix
 *   2. the last text-bearing message — caches the whole conversation prefix so a
 *      multi-turn tool loop (and resumed-session history) reuses the cache.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface CacheTextPart {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
}

/** A message as sent on the wire — content may be a cached text-part array. */
export type RequestMessage = Omit<ChatMessage, "content"> & {
  content: string | null | CacheTextPart[];
};

/** Providers that require an explicit cache_control breakpoint via OpenRouter. */
export function modelSupportsExplicitCache(model: string): boolean {
  return /^(anthropic|google)\//i.test(model.trim());
}

function cachedContent(text: string): CacheTextPart[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

/**
 * Returns request-ready messages. When caching does not apply (disabled, or a
 * provider that caches implicitly) the original array is returned unchanged.
 */
export function buildRequestMessages(
  messages: ChatMessage[],
  model: string,
  enabled: boolean,
): ChatMessage[] | RequestMessage[] {
  if (!enabled || !modelSupportsExplicitCache(model)) return messages;

  const out: RequestMessage[] = messages.map((m) => ({ ...m }));
  const cacheIndexes = new Set<number>();

  const systemIdx = out.findIndex(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.trim().length > 0,
  );
  if (systemIdx >= 0) cacheIndexes.add(systemIdx);

  for (let i = out.length - 1; i >= 0; i--) {
    const content = out[i]?.content;
    if (typeof content === "string" && content.trim().length > 0) {
      cacheIndexes.add(i);
      break;
    }
  }

  for (const i of cacheIndexes) {
    const message = out[i];
    if (message && typeof message.content === "string") {
      out[i] = { ...message, content: cachedContent(message.content) };
    }
  }
  return out;
}
