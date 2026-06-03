/**
 * Paperclip skills support — "ephemeral" mode for a direct-API adapter.
 *
 * Unlike CLI adapters (which materialize company skill files into a runtime's
 * on-disk skills directory for a separate agent process to discover), this
 * adapter drives a REMOTE model with no filesystem of its own. So we read the
 * company's skill markdown from Paperclip's own on-disk skill store (we run
 * in-process, in the same container) and INJECT it into the system prompt at
 * run time. Paperclip's contract calls this `mode: "ephemeral"`.
 *
 * The snapshot builder + section renderer are pure (and unit-tested); the
 * fs-touching entry points use the published adapter-utils skill helpers.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  type PaperclipSkillEntry,
  readPaperclipRuntimeSkillEntries,
  readPaperclipSkillMarkdown,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** A skill resolved to its markdown body, ready for prompt injection. */
export interface LoadedSkill {
  key: string;
  content: string;
}

/**
 * Map the company's available skill entries + the desired selection into the
 * AdapterSkillSnapshot the Paperclip UI renders. Pure — no fs. We build it by
 * hand (rather than via buildRuntimeMountedSkillSnapshot) because that helper
 * is not in the published @paperclipai/adapter-utils this package depends on.
 */
export function buildSkillSnapshot(
  entries: PaperclipSkillEntry[],
  desired: string[],
): AdapterSkillSnapshot {
  const desiredSet = new Set(desired);
  const skillEntries: AdapterSkillEntry[] = entries.map((entry) => {
    const isDesired = desiredSet.has(entry.key);
    return {
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired: isDesired,
      managed: true,
      required: entry.required,
      requiredReason: entry.requiredReason,
      // "configured" = selected and will be injected next run; "available" =
      // present but not selected. There is nothing to install on disk in
      // ephemeral mode, so we never report "installed"/"missing".
      state: isDesired ? "configured" : "available",
      origin: "company_managed",
      sourcePath: entry.source,
      detail: isDesired
        ? "Injected into the model's system prompt at run time (ephemeral)."
        : "Available — select to inject it into the prompt.",
    };
  });
  return {
    adapterType: "openrouter",
    supported: true,
    mode: "ephemeral",
    desiredSkills: entries.filter((e) => desiredSet.has(e.key)).map((e) => e.key),
    entries: skillEntries,
    warnings: [],
  };
}

/**
 * Render the selected skills as a `## Skills` system-prompt section. Pure.
 * Returns "" when nothing is selected so the prompt is unchanged.
 */
export function renderSkillsSection(loaded: LoadedSkill[]): string {
  if (loaded.length === 0) return "";
  const blocks = loaded.map((s) => `### Skill: ${s.key}\n\n${s.content.trim()}`);
  return [
    "## Skills",
    "The following skills are available to you. Apply them when they are relevant to the task.",
    ...blocks,
    "",
  ].join("\n\n");
}

/**
 * Read the markdown for every selected skill, ready to inject. fs-touching.
 * Skills whose body can't be read are skipped (best-effort), never fatal.
 */
export async function loadDesiredSkills(
  config: Record<string, unknown>,
  moduleDir: string,
): Promise<LoadedSkill[]> {
  const entries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desired = new Set(resolvePaperclipDesiredSkillNames(config, entries));
  const loaded: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!desired.has(entry.key)) continue;
    let content = await readPaperclipSkillMarkdown(moduleDir, entry.key);
    if (!content) {
      content = await fs.readFile(entry.source, "utf8").catch(() => null);
    }
    if (content && content.trim().length > 0) {
      loaded.push({ key: entry.runtimeName ?? entry.key, content });
    }
  }
  return loaded;
}

/**
 * listSkills hook — report the company's available skills and which are
 * selected. Implementing this (and syncSkills) is what flips Paperclip's
 * `supportsSkills` to true and surfaces the skill picker for the adapter.
 */
export async function listOpenRouterSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const entries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desired = resolvePaperclipDesiredSkillNames(ctx.config, entries);
  return buildSkillSnapshot(entries, desired);
}

/**
 * syncSkills hook — ephemeral mode has nothing to install on disk, so we just
 * reflect the requested selection back as the new snapshot (Paperclip persists
 * the desired set; injection happens at execute() time).
 */
export async function syncOpenRouterSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const entries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  return buildSkillSnapshot(entries, desiredSkills);
}

/** Load the selected skills relative to this module's directory. */
export function loadDesiredSkillsForRun(config: Record<string, unknown>): Promise<LoadedSkill[]> {
  return loadDesiredSkills(config, __moduleDir);
}
