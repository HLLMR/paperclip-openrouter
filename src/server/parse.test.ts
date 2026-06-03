import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthError, isToolUseUnsupported, parseOpenRouterResponse } from "./parse.js";

test("parses assistant text, usage, and cost from an OpenRouter response", () => {
  const parsed = parseOpenRouterResponse({
    id: "gen-123",
    model: "openai/gpt-4o-mini",
    choices: [{ message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00012 },
  });
  assert.equal(parsed.id, "gen-123");
  assert.equal(parsed.model, "openai/gpt-4o-mini");
  assert.equal(parsed.text, "hello world");
  assert.equal(parsed.finishReason, "stop");
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 5 });
  assert.equal(parsed.costUsd, 0.00012);
  assert.equal(parsed.assistant.toolCalls.length, 0);
});

test("parses tool calls with JSON arguments", () => {
  const parsed = parseOpenRouterResponse({
    id: "gen-tool",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "fs_read_file", arguments: '{"path":"README.md"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  assert.equal(parsed.assistant.toolCalls.length, 1);
  const call = parsed.assistant.toolCalls[0];
  assert.equal(call?.name, "fs_read_file");
  assert.deepEqual(call?.arguments, { path: "README.md" });
});

test("falls back to _rawArguments when tool arguments are not valid JSON", () => {
  const parsed = parseOpenRouterResponse({
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "not json" } }],
        },
      },
    ],
  });
  assert.deepEqual(parsed.assistant.toolCalls[0]?.arguments, { _rawArguments: "not json" });
});

test("isAuthError detects auth failures by status and body", () => {
  assert.equal(isAuthError(401, ""), true);
  assert.equal(isAuthError(403, ""), true);
  assert.equal(isAuthError(400, "Invalid API key provided"), true);
  assert.equal(isAuthError(200, "all good"), false);
});

test("isToolUseUnsupported detects tool-incapable model errors", () => {
  assert.equal(isToolUseUnsupported(404, "No endpoints found that support tool use"), true);
  assert.equal(isToolUseUnsupported(400, "Tools are not supported for this model"), true);
  assert.equal(isToolUseUnsupported(400, "some other error"), false);
});
