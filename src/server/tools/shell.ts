import { spawn } from "node:child_process";
import type { AdapterTool, ToolEnvironment } from "./types.js";

// Cap on captured stdout/stderr so a runaway command can't exhaust memory or
// flood the model's context; output past this is dropped and flagged.
const MAX_SHELL_OUTPUT_BYTES = 64 * 1024;

// SECURITY: allow-list gate for shell commands.
// A null/empty list means "no allow-list configured" — note this returns TRUE
// (permissive) here, because the primary off-switch is `shellEnabled`; the
// allow-list is a secondary narrowing applied only when an operator sets one.
// Matching is a simple prefix test on the trimmed command string.
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
    // Run via `bash -lc` so login-shell PATH/profile is in effect. env is the
    // process env overlaid with the run-specific overrides (cwd scopes it).
    const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    // Watchdog: on timeout, flag it and SIGTERM the child so it can't hang the
    // run indefinitely. kill() is wrapped because the child may already be gone.
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, timeoutMs);
    // Accumulate output with a running byte cap per stream. Once either stream
    // would exceed the cap we keep the first MAX bytes and set `truncated`, so
    // streaming a huge payload can't grow memory without bound.
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
    // Normal exit: cancel the watchdog, note any truncation, return the result.
    child.on("close", (code) => {
      clearTimeout(timer);
      if (truncated) stderr += `\n[output truncated at ${MAX_SHELL_OUTPUT_BYTES} bytes]`;
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    // Spawn failure (e.g. bash missing): resolve with a synthetic exit 1 rather
    // than rejecting, so the caller always gets a uniform BashResult.
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
  // PRIMARY SECURITY GATE: the tool is not even advertised unless the run
  // explicitly opted in. This is what keeps shell access off by default.
  enabled: (env) => env.shellEnabled === true,
  async invoke(input, env) {
    const params = input ?? {};
    if (typeof params.command !== "string" || params.command.trim().length === 0) {
      return { ok: false, content: "command must be a non-empty string", isError: true };
    }
    // SECONDARY GATE: even when enabled, reject anything outside the allow-list.
    if (!isAllowed(params.command, env.shellAllowList)) {
      return { ok: false, content: "command rejected by tools.shell.allowList", isError: true };
    }
    // Clamp the caller's optional timeout into [1, 600]s; fall back to the
    // run default. Bounds prevent a 0/negative or huge timeout being honored.
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
