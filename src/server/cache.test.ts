import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequestMessages, modelSupportsExplicitCache, type ChatMessage } from "./cache.js";

const messages: ChatMessage[] = [
  { role: "system", content: "You are an agent. Big stable system prompt." },
  { role: "user", content: "first task" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "fs_list_dir", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", name: "fs_list_dir", content: "file a\nfile b" },
  { role: "user", content: "continue" },
];

test("modelSupportsExplicitCache only matches Anthropic and Gemini", () => {
  assert.equal(modelSupportsExplicitCache("anthropic/claude-3.5-sonnet"), true);
  assert.equal(modelSupportsExplicitCache("google/gemini-2.0-flash-001"), true);
  assert.equal(modelSupportsExplicitCache("openai/gpt-4o-mini"), false);
  assert.equal(modelSupportsExplicitCache("deepseek/deepseek-chat"), false);
  // OpenRouter "latest" aliases carry a leading `~` — they must still cache.
  assert.equal(modelSupportsExplicitCache("~anthropic/claude-opus-latest"), true);
  assert.equal(modelSupportsExplicitCache("~google/gemini-pro-latest"), true);
  assert.equal(modelSupportsExplicitCache("~openai/gpt-4o-latest"), false);
});

test("non-Anthropic models are returned unchanged (string content)", () => {
  const out = buildRequestMessages(messages, "openai/gpt-4o-mini", true);
  assert.equal(out, messages);
  assert.equal(typeof out[0]?.content, "string");
});

test("disabled caching returns messages unchanged", () => {
  const out = buildRequestMessages(messages, "anthropic/claude-3.5-sonnet", false);
  assert.equal(out, messages);
});

test("Anthropic models get cache_control on system and last text message only", () => {
  const out = buildRequestMessages(messages, "anthropic/claude-3.5-sonnet", true);
  // system (index 0) cached
  assert.ok(Array.isArray(out[0]?.content), "system content should be an array");
  const sysPart = (out[0]?.content as unknown as Array<{ cache_control?: unknown }>)[0];
  assert.deepEqual(sysPart?.cache_control, { type: "ephemeral" });
  // last user message (index 4) cached
  assert.ok(Array.isArray(out[4]?.content), "last message content should be an array");
  // a middle message left as-is
  assert.equal(typeof out[1]?.content, "string");
  // the tool-call assistant message (null content) is never converted
  assert.equal(out[2]?.content, null);
  // exactly two breakpoints
  const cached = out.filter((m) => Array.isArray(m.content));
  assert.equal(cached.length, 2);
});

test("does not mutate the input messages array", () => {
  const before = JSON.stringify(messages);
  buildRequestMessages(messages, "anthropic/claude-3.5-sonnet", true);
  assert.equal(JSON.stringify(messages), before);
});

function cacheControlOf(out: ReturnType<typeof buildRequestMessages>, idx: number): unknown {
  const parts = out[idx]?.content as unknown as Array<{ cache_control?: unknown }>;
  return parts[0]?.cache_control;
}

test("default ttl (5m) omits the ttl field", () => {
  const out = buildRequestMessages(messages, "anthropic/claude-3.5-sonnet", true);
  assert.deepEqual(cacheControlOf(out, 0), { type: "ephemeral" });
});

test("ttl=1h adds the extended-cache marker", () => {
  const out = buildRequestMessages(messages, "anthropic/claude-3.5-sonnet", true, "1h");
  assert.deepEqual(cacheControlOf(out, 0), { type: "ephemeral", ttl: "1h" });
});
