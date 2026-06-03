import type { AdapterAgent } from "@paperclipai/adapter-utils";

/**
 * Runtime environment handed to every tool invocation.
 *
 * This is the single capability/configuration object threaded through every
 * tool's `enabled()` and `invoke()`. Tools read their security limits from
 * here rather than from globals, so a run's policy (allow-lists, byte caps,
 * credentials) is fully determined by the env constructed for that run.
 */
export interface ToolEnvironment {
  // Working directory that scopes the fs tools and is the spawn cwd for shell.
  cwd: string;
  // The Paperclip agent identity for this run (carries companyId, etc.).
  agent: AdapterAgent;
  // Unique id for this adapter run; stamped on outbound Paperclip API calls.
  runId: string;
  // Paperclip API base URL + bearer key. Null when the run has no API access;
  // the paperclip tools self-disable in that case.
  paperclipApiUrl: string | null;
  paperclipApiKey: string | null;
  // shell_exec is OFF unless explicitly enabled for this run (security gate).
  shellEnabled: boolean;
  // Optional prefix allow-list for shell commands; null/empty means no filter.
  shellAllowList: string[] | null;
  // Default wall-clock timeout (seconds) for shell commands.
  shellTimeoutSec: number;
  // When false, fs tools refuse any path that resolves outside `cwd`.
  fsAllowOutsideCwd: boolean;
  // Hard cap on bytes read/written by fs tools (truncation / rejection limit).
  fsMaxBytes: number;
  // Extra environment variables layered onto the shell child process.
  env: Record<string, string>;
}

/** Uniform return shape from a tool invocation. */
export interface ToolResult {
  // True on success. Drives control flow inside the adapter.
  ok: boolean;
  // Human/model-readable payload (text). Truncated to byte caps by the tool.
  content: string;
  // Distinguishes a tool-level error from a plain unsuccessful-but-valid
  // result; surfaced to the model as the tool_result `isError` flag.
  isError?: boolean;
}

/** JSON-Schema-ish parameter object passed straight to OpenRouter. */
export type ToolParameters = Record<string, unknown>;

/** An in-process tool the model can call, plus its enable-gate and handler. */
export interface AdapterTool {
  // Wire name the model uses to call the tool; must be unique in the registry.
  name: string;
  // Model-facing description (becomes the function-tool description).
  description: string;
  // JSON-Schema for the call arguments, passed through to OpenRouter verbatim.
  parameters: ToolParameters;
  // Per-run gate: tools that lack their prerequisites (creds, opt-in flags)
  // return false so they are never advertised to the model for that run.
  enabled: (env: ToolEnvironment) => boolean;
  // Executes the tool. Receives the model-supplied args (untrusted, so each
  // tool re-validates) and the run env. May be sync or async.
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
