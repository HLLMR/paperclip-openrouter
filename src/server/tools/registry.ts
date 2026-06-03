import type { AdapterTool, OpenRouterTool, ToolEnvironment } from "./types.js";

// Project the adapter's tool list onto the OpenRouter `tools[]` wire shape.
// Only tools whose `enabled(env)` gate passes for THIS run are advertised, so
// the model can never call a tool whose prerequisites (creds, opt-in) are
// absent. Each surviving tool is wrapped as a `type: "function"` descriptor.
export function toOpenRouterTools(tools: AdapterTool[], env: ToolEnvironment): OpenRouterTool[] {
  return tools
    .filter((t) => t.enabled(env))
    .map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

// Resolve a tool by its wire name when dispatching a model tool_call.
// Returns null (rather than throwing) for unknown names so the caller can
// surface a clean error to the model instead of crashing the run.
export function findTool(tools: AdapterTool[], name: string): AdapterTool | null {
  return tools.find((t) => t.name === name) ?? null;
}
