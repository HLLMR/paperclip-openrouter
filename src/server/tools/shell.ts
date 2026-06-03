import { spawn } from "node:child_process";
import type { AdapterTool, ToolEnvironment } from "./types.js";

const MAX_SHELL_OUTPUT_BYTES = 64 * 1024;

function isAllowed(command: string, allowList: string[] | null): boolean {
  if (!allowList || allowList.length === 0) return true;
  const trimmed = command.trim();
  return allowList.some((prefix) => trimmed.startsWith(prefix));
}

interface BashResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<BashResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, timeoutMs);
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") {
        if (stdout.length + text.length > MAX_SHELL_OUTPUT_BYTES) {
          stdout = (stdout + text).slice(0, MAX_SHELL_OUTPUT_BYTES);
          truncated = true;
        } else {
          stdout += text;
        }
      } else {
        if (stderr.length + text.length > MAX_SHELL_OUTPUT_BYTES) {
          stderr = (stderr + text).slice(0, MAX_SHELL_OUTPUT_BYTES);
          truncated = true;
        } else {
          stderr += text;
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (truncated) stderr += `\n[output truncated at ${MAX_SHELL_OUTPUT_BYTES} bytes]`;
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr + `\nspawn error: ${err.message}`, timedOut });
    });
  });
}

export const shellExecTool: AdapterTool = {
  name: "shell_exec",
  description:
    "Run a bash command inside the adapter cwd. Disabled by default; opt-in via tools.shell.enabled. Honors tools.shell.allowList prefix matching.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to run." },
      timeoutSec: {
        type: "integer",
        minimum: 1,
        maximum: 600,
        description: "Optional timeout in seconds; defaults to adapter shellTimeoutSec.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  enabled: (env) => env.shellEnabled === true,
  async invoke(input, env) {
    const params = input ?? {};
    if (typeof params.command !== "string" || params.command.trim().length === 0) {
      return { ok: false, content: "command must be a non-empty string", isError: true };
    }
    if (!isAllowed(params.command, env.shellAllowList)) {
      return { ok: false, content: "command rejected by tools.shell.allowList", isError: true };
    }
    const timeoutSec =
      typeof params.timeoutSec === "number" && Number.isFinite(params.timeoutSec)
        ? Math.min(600, Math.max(1, params.timeoutSec))
        : env.shellTimeoutSec;
    const result = await runBash(params.command, env.cwd, timeoutSec * 1000, env.env);
    const blocks: string[] = [`exitCode: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`];
    if (result.stdout) blocks.push(`--- stdout ---\n${result.stdout}`);
    if (result.stderr) blocks.push(`--- stderr ---\n${result.stderr}`);
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      content: blocks.join("\n"),
      isError: result.exitCode !== 0 || result.timedOut,
    };
  },
};
