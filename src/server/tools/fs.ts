import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterTool, ToolEnvironment } from "./types.js";

// SECURITY: central choke point for every fs path the model supplies.
// All three fs tools route their `path` argument through here before touching
// disk, so the containment policy lives in exactly one place.
function resolveSafePath(
  env: ToolEnvironment,
  target: unknown,
): { resolved: string | null; reason: string | null } {
  // Reject non-string / blank input up front — the model arg is untrusted.
  if (typeof target !== "string" || target.trim().length === 0) {
    return { resolved: null, reason: "path must be a non-empty string" };
  }
  const trimmed = target.trim();
  // Normalize to an absolute path. Relative paths are anchored at cwd; `..`
  // segments are collapsed by path.resolve so escapes can't hide inside them.
  const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(env.cwd, trimmed);
  // Containment check (skipped only when the run explicitly opts out).
  if (!env.fsAllowOutsideCwd) {
    // Append the path separator to the root so a sibling dir sharing a prefix
    // (e.g. /work vs /work-secrets) cannot satisfy the startsWith() test.
    const root = path.resolve(env.cwd) + path.sep;
    // Inside == the cwd itself, or a descendant under `<cwd>/`. Comparing the
    // already-resolved path defeats `..` traversal and absolute-path escapes.
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

// Coerce an untrusted numeric arg into [min, max], substituting `fallback` for
// non-finite / non-number input. Used to bound offset/limit so the model can't
// pass absurd or hostile values.
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
    // Gate on the shared path-safety check before any disk access.
    const { resolved, reason } = resolveSafePath(env, params.path);
    if (!resolved) return { ok: false, content: reason ?? "invalid path", isError: true };
    try {
      const bytes = await fs.readFile(resolved);
      let text = bytes.toString("utf8");
      // Byte cap: hard-truncate oversized files so a huge file can't blow up
      // the context window or memory; annotate so the model knows it's partial.
      if (bytes.byteLength > env.fsMaxBytes) {
        text =
          text.slice(0, env.fsMaxBytes) +
          `\n\n[truncated: file is ${bytes.byteLength} bytes, limit ${env.fsMaxBytes}]`;
      }
      // Optional line-window paging over the (already byte-capped) text.
      const offset = clampNumber(params.offset, 0, 0, 1_000_000);
      const limit = clampNumber(params.limit, 5000, 1, 5000);
      // Only slice when the caller actually narrowed the window, to avoid the
      // cost of splitting on the common "read the whole file" path.
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
    // Same containment gate as reads — writes outside cwd are the bigger risk.
    const { resolved, reason } = resolveSafePath(env, params.path);
    if (!resolved) return { ok: false, content: reason ?? "invalid path", isError: true };
    if (typeof params.content !== "string") {
      return { ok: false, content: "content must be a string", isError: true };
    }
    // Reject (don't truncate) oversized writes: a partial file would be wrong.
    if (Buffer.byteLength(params.content, "utf8") > env.fsMaxBytes) {
      return { ok: false, content: `content exceeds fsMaxBytes (${env.fsMaxBytes})`, isError: true };
    }
    try {
      // Create missing parent dirs so a single write can land a nested path.
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      // Validate the optional mode; default to 0o644 (owner rw, others r).
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
    // Containment gate applies to directory listing too (avoids info leak).
    const { resolved, reason } = resolveSafePath(env, params.path);
    if (!resolved) return { ok: false, content: reason ?? "invalid path", isError: true };
    try {
      // withFileTypes lets us label entries without an extra stat per name.
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const lines = entries
        // Stable alphabetical order so listings are deterministic for the model.
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          // Surface symlinks distinctly — they are a path-escape vector the
          // model/operator should be aware of.
          const kind = e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file";
          return `${kind} ${e.name}`;
        });
      return { ok: true, content: lines.length > 0 ? lines.join("\n") : "(empty directory)" };
    } catch (err) {
      return { ok: false, content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
