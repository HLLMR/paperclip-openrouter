import assert from "node:assert/strict";
import { test } from "node:test";
import { findTool, toOpenRouterTools } from "./registry.js";
import type { AdapterTool, ToolEnvironment } from "./types.js";

const env = {} as ToolEnvironment;

function tool(name: string, enabled: boolean): AdapterTool {
  return {
    name,
    description: `desc-${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    enabled: () => enabled,
    invoke: () => ({ ok: true, content: "" }),
  };
}

test("toOpenRouterTools includes only enabled tools, in wire shape", () => {
  const tools = [tool("a", true), tool("b", false), tool("c", true)];
  const wire = toOpenRouterTools(tools, env);
  assert.equal(wire.length, 2);
  assert.deepEqual(
    wire.map((w) => w.function.name),
    ["a", "c"],
  );
  assert.equal(wire[0]?.type, "function");
  assert.equal(wire[0]?.function.description, "desc-a");
  assert.deepEqual(wire[0]?.function.parameters, { type: "object", properties: {}, additionalProperties: false });
});

test("toOpenRouterTools returns [] when nothing is enabled", () => {
  assert.deepEqual(toOpenRouterTools([tool("a", false)], env), []);
});

test("findTool returns the named tool or null", () => {
  const tools = [tool("a", true), tool("b", true)];
  assert.equal(findTool(tools, "b")?.name, "b");
  assert.equal(findTool(tools, "missing"), null);
});
