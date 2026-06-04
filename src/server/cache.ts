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

/**
 * Cache lifetime. "5m" is Anthropic's default ephemeral cache; "1h" is the
 * extended cache — worth it for agents whose heartbeats are spaced more than
 * five minutes apart, so the cached prefix survives between wakes (a 1h write
 * costs more, but is repaid by a single read within the hour).
 */
export type CacheTtl = "5m" | "1h";

interface CacheTextPart {
  type: "text";
  text: string;
  // `ttl` is omitted for the 5m default; OpenRouter forwards "1h" to the
  // provider's extended cache.
  cache_control: { type: "ephemeral"; ttl?: "1h" };
}

/** A message as sent on the wire — content may be a cached text-part array. */
export type RequestMessage = Omit<ChatMessage, "content"> & {
  content: string | null | CacheTextPart[];
};

/** Providers that require an explicit cache_control breakpoint via OpenRouter. */
export function modelSupportsExplicitCache(model: string): boolean {
  // The optional leading `~` is OpenRouter's marker for a floating "latest"
  // alias (e.g. `~anthropic/claude-opus-latest`). Tolerate it so alias ids
  // cache just like their pinned counterparts (`anthropic/claude-opus-4.8`).
  return /^~?(anthropic|google)\//i.test(model.trim());
}

// Wrap a plain string body in the single-part array shape OpenRouter expects
// when attaching a cache breakpoint. Adds the "1h" extended-cache marker only
// when requested; otherwise the provider default (5m) applies.
function cachedContent(text: string, ttl: CacheTtl): CacheTextPart[] {
  const cache_control: CacheTextPart["cache_control"] =
    ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  return [{ type: "text", text, cache_control }];
}

/**
 * Returns request-ready messages. When caching does not apply (disabled, or a
 * provider that caches implicitly) the original array is returned unchanged.
 */
export function buildRequestMessages(
  messages: ChatMessage[],
  model: string,
  enabled: boolean,
  ttl: CacheTtl = "5m",
): ChatMessage[] | RequestMessage[] {
  // Fast path: caching off, or a provider that caches implicitly — return the
  // caller's array untouched (no copy, no rewrite).
  if (!enabled || !modelSupportsExplicitCache(model)) return messages;

  // Shallow-copy every message so we never mutate the caller's input; only the
  // breakpoint-bearing entries get their content replaced below.
  const out: RequestMessage[] = messages.map((m) => ({ ...m }));
  // A Set so the first and last breakpoint coincide harmlessly when there's only
  // one text-bearing message (no double-wrapping).
  const cacheIndexes = new Set<number>();

  // Breakpoint 1: the first non-empty system message — caches the large, stable
  // system + tool-schema prefix that's identical on every turn.
  const systemIdx = out.findIndex(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.trim().length > 0,
  );
  if (systemIdx >= 0) cacheIndexes.add(systemIdx);

  // Breakpoint 2: the last text-bearing message — extends the cached prefix to
  // cover the whole conversation so far, so the next tool-loop turn (or a resumed
  // session) reuses everything up to here. We scan from the end and stop at the
  // first hit. Anthropic permits four breakpoints; two is enough to cache both the
  // static header and the growing history.
  for (let i = out.length - 1; i >= 0; i--) {
    const content = out[i]?.content;
    if (typeof content === "string" && content.trim().length > 0) {
      cacheIndexes.add(i);
      break;
    }
  }

  // Apply the breakpoints: convert the selected string bodies into cache-tagged
  // text-part arrays. Guard on string content since an earlier pass could already
  // have rewritten this index (the single-message overlap case).
  for (const i of cacheIndexes) {
    const message = out[i];
    if (message && typeof message.content === "string") {
      out[i] = { ...message, content: cachedContent(message.content, ttl) };
    }
  }
  return out;
}
