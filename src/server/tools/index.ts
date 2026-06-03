import { fsListDirTool, fsReadFileTool, fsWriteFileTool } from "./fs.js";
import { paperclipApiRequestTool, paperclipSearchIssuesTool } from "./paperclip.js";
import { shellExecTool } from "./shell.js";
import type { AdapterTool } from "./types.js";

export const builtinTools: AdapterTool[] = [
  paperclipApiRequestTool,
  paperclipSearchIssuesTool,
  fsReadFileTool,
  fsWriteFileTool,
  fsListDirTool,
  shellExecTool,
];

export { findTool, toOpenRouterTools } from "./registry.js";
export type { AdapterTool, ToolEnvironment, ToolResult, OpenRouterTool } from "./types.js";
