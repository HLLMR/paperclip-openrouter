import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStdoutLine, createStdoutParser } from "./ui-parser.js";

const TS = "2026-06-03T00:00:00.000Z";

test("init line -> init entry (runId maps to sessionId)", () => {
  const out = parseStdoutLine(
    JSON.stringify({ type: "system", subtype: "init", model: "openai/gpt-4o-mini", runId: "run-1" }),
    TS,
  );
  assert.deepEqual(out, [{ kind: "init", ts: TS, model: "openai/gpt-4o-mini", sessionId: "run-1" }]);
});

test("assistant message -> assistant entry; non-assistant role -> system", () => {
  assert.deepEqual(parseStdoutLine(JSON.stringify({ type: "message", role: "assistant", text: "hi" }), TS), [
    { kind: "assistant", ts: TS, text: "hi" },
  ]);
  assert.deepEqual(parseStdoutLine(JSON.stringify({ type: "message", role: "tool", text: "note" }), TS), [
    { kind: "system", ts: TS, text: "note" },
  ]);
});

test("empty message text is dropped (returns [])", () => {
  assert.deepEqual(parseStdoutLine(JSON.stringify({ type: "message", role: "assistant", text: "" }), TS), []);
});

test("tool_call -> tool_call entry with passthrough input", () => {
  const out = parseStdoutLine(
    JSON.stringify({ type: "tool_call", name: "fs_read_file", input: { path: "README.md" }, toolUseId: "c1" }),
    TS,
  );
  assert.deepEqual(out, [
    { kind: "tool_call", ts: TS, name: "fs_read_file", input: { path: "README.md" }, toolUseId: "c1" },
  ]);
});

test("tool_result -> tool_result entry; isError is strict === true", () => {
  const ok = parseStdoutLine(
    JSON.stringify({ type: "tool_result", toolUseId: "c1", toolName: "fs_read_file", content: "data", isError: "nope" }),
    TS,
  );
  assert.equal(ok[0]?.kind, "tool_result");
  assert.equal((ok[0] as { isError: boolean }).isError, false, "non-boolean isError must read as false");
  const err = parseStdoutLine(
    JSON.stringify({ type: "tool_result", toolUseId: "c1", toolName: "x", content: "boom", isError: true }),
    TS,
  );
  assert.equal((err[0] as { isError: boolean }).isError, true);
});

test("result -> result entry; cachedInputTokens maps to cachedTokens", () => {
  const out = parseStdoutLine(
    JSON.stringify({
      type: "result",
      model: "anthropic/claude-3.5-haiku",
      finishReason: "stop",
      elapsedMs: 1234,
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
      costUsd: 0.0012,
      isError: false,
    }),
    TS,
  );
  const r = out[0] as unknown as Record<string, unknown>;
  assert.equal(r.kind, "result");
  assert.equal(r.inputTokens, 100);
  assert.equal(r.outputTokens, 20);
  assert.equal(r.cachedTokens, 80);
  assert.equal(r.costUsd, 0.0012);
  assert.equal(r.subtype, "stop");
  assert.equal(r.isError, false);
  assert.match(String(r.text), /finish_reason=stop/);
});

test("[paperclip] annotation -> system entry with prefix stripped", () => {
  assert.deepEqual(parseStdoutLine("[paperclip] Syncing workspace", TS), [
    { kind: "system", ts: TS, text: "Syncing workspace" },
  ]);
});

test("non-JSON line -> raw stdout passthrough", () => {
  assert.deepEqual(parseStdoutLine("just some text", TS), [{ kind: "stdout", ts: TS, text: "just some text" }]);
});

test("error line -> stderr entry", () => {
  assert.deepEqual(parseStdoutLine(JSON.stringify({ type: "error", message: "kaboom" }), TS), [
    { kind: "stderr", ts: TS, text: "kaboom" },
  ]);
});

test("unknown type -> raw stdout fallback", () => {
  const line = JSON.stringify({ type: "mystery", foo: 1 });
  assert.deepEqual(parseStdoutLine(line, TS), [{ kind: "stdout", ts: TS, text: line }]);
});

test("createStdoutParser exposes a stateless parseLine + reset", () => {
  const p = createStdoutParser();
  assert.equal(typeof p.parseLine, "function");
  assert.equal(typeof p.reset, "function");
  p.reset();
  assert.deepEqual(p.parseLine("[paperclip] hi", TS), [{ kind: "system", ts: TS, text: "hi" }]);
});
