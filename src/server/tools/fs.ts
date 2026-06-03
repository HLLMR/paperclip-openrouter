import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterTool, ToolEnvironment } from "./types.js";

function resolveSafePath(
  env: ToolEnvironment,
  target: unknown,
): { resolved: string | null; reason: string | null } {
  if (typeof target !== "string" || target.trim().length === 0) {
    return { resolved: null, reason: "path must be a non-empty string" };
  }
  const trimmed = target.trim();
  const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(env.cwd, trimmed);
  if (!env.fsAllowOutsideCwd) {
    const root = path.resolve(env.cwd) + path.sep;
    const inside = resolved === path.resolve(env.cwd) || resolved.startsWith(root);
    if (!inside) {
      return {
        resolved: null,
        reason: `path escapes the adapter cwd (${env.cwd}); set tools.fs.allowOutsideCwd=true to permit`,
      };
    }
  }
  return { resolved, reason: null };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, n));
}

export const fsReadFileTool: AdapterTool = {
  name: "fs_read_file",
  description:
    "Read a UTF-8 text file from the adapter cwd. Returns up to fsMaxBytes bytes; supports optional offset/limit on lines.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to cwd, or absolute when fs.allowOutsideCwd is enabled." },
      offset: { type: "integer", minimum: 0, description: "Optional starting line (0-based)." },
      limit: { type: "integer", minimum: 1, maximum: 5000, description: "Optional max number of lines to return." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  enabled: () => true,
  async invoke(input, env) {
    const params = input ?? {};
    const { resolved, reason } = resolveSafePath(env, params.path);
    if (!resolved) return { ok: false, content: reason ?? "invalid path", isError: true };
    try {
      const bytes = await fs.readFile(resolved);
      let text = bytes.toString("utf8");
      if (bytes.byteLength > env.fsMaxBytes) {
        text =
          text.slice(0, env.fsMaxBytes) +
          `\n\n[truncated: file is ${bytes.byteLength} bytes, limit ${env.fsMaxBytes}]`;
      }
      const offset = clampNumber(params.offset, 0, 0, 1_000_000);
      const limit = clampNumber(params.limit, 5000, 1, 5000);
      if (offset > 0 || limit < 5000) {
        const lines = text.split(/\r?\n/);
        text = lines.slice(offset, offset + limit).join("\n");
      }
      return { ok: true, content: text };
    } catch (err) {
      return { ok: false, content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};

export const fsWriteFileTool: AdapterTool = {
  name: "fs_write_file",
  description:
    "Create or overwrite a UTF-8 text file inside the adapter cwd. Parent directories are created as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to cwd, or absolute when fs.allowOutsideCwd is enabled." },
      content: { type: "string", description: "File content. Must be a string." },
      mode: { type: "integer", description: "Optional Unix file mode in decimal of the octal value (e.g. 420 = 0o644)." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  enabled: () => true,
  async invoke(input, env) {
    const params = input ?? {};
    const { resolved, reason } = resolveSafePath(env, params.path);
    if (!resolved) return { ok: false, content: reason ?? "invalid path", isError: true };
    if (typeof params.content !== "string") {
      return { ok: false, content: "content must be a string", isError: true };
    }
    if (Buffer.byteLength(params.content, "utf8") > env.fsMaxBytes) {
      return { ok: false, content: `content exceeds fsMaxBytes (${env.fsMaxBytes})`, isError: true };
    }
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const mode =
        typeof params.mode === "number" && Number.isFinite(params.mode) ? params.mode : 0o644;
      await fs.writeFile(resolved, params.content, { mode });
      return { ok: true, content: `wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${resolved}` };
    } catch (err) {
      return { ok: false, content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};

export const fsListDirTool: AdapterTool = {
  name: "fs_list_dir",
  description:
    "List entries in a directory inside the adapter cwd. Returns one entry per line as `<type> <name>`.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to cwd, or absolute when fs.allowOutsideCwd is enabled." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  enabled: () => true,
  async invoke(input, env) {
    const params = input ?? {};
    const { resolved, reason } = resolveSafePath(env, params.path);
    if (!resolved) return { ok: false, content: reason ?? "invalid path", isError: true };
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          const kind = e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file";
          return `${kind} ${e.name}`;
        });
      return { ok: true, content: lines.length > 0 ? lines.join("\n") : "(empty directory)" };
    } catch (err) {
      return { ok: false, content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
