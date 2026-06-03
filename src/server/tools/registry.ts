import type { AdapterTool, OpenRouterTool, ToolEnvironment } from "./types.js";

export function toOpenRouterTools(tools: AdapterTool[], env: ToolEnvironment): OpenRouterTool[] {
  return tools
    .filter((t) => t.enabled(env))
    .map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

export function findTool(tools: AdapterTool[], name: string): AdapterTool | null {
  return tools.find((t) => t.name === name) ?? null;
}
