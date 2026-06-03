import type { AdapterAgent } from "@paperclipai/adapter-utils";

/** Runtime environment handed to every tool invocation. */
export interface ToolEnvironment {
  cwd: string;
  agent: AdapterAgent;
  runId: string;
  paperclipApiUrl: string | null;
  paperclipApiKey: string | null;
  shellEnabled: boolean;
  shellAllowList: string[] | null;
  shellTimeoutSec: number;
  fsAllowOutsideCwd: boolean;
  fsMaxBytes: number;
  env: Record<string, string>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  isError?: boolean;
}

/** JSON-Schema-ish parameter object passed straight to OpenRouter. */
export type ToolParameters = Record<string, unknown>;

export interface AdapterTool {
  name: string;
  description: string;
  parameters: ToolParameters;
  enabled: (env: ToolEnvironment) => boolean;
  invoke: (input: Record<string, unknown>, env: ToolEnvironment) => Promise<ToolResult> | ToolResult;
}

/** The OpenAI/OpenRouter `tools[]` function-tool wire shape. */
export interface OpenRouterTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}
