import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import { buildSkillSnapshot, renderSkillsSection } from "./skills.js";

const entries: PaperclipSkillEntry[] = [
  { key: "pr-review", runtimeName: "pr-review", source: "/skills/pr-review.md", required: false },
  { key: "deploy", runtimeName: "deploy", source: "/skills/deploy.md", required: true, requiredReason: "ops" },
  { key: "triage", runtimeName: "triage", source: "/skills/triage.md" },
];

test("buildSkillSnapshot reports ephemeral + supported and marks desired entries configured", () => {
  const snap = buildSkillSnapshot(entries, ["pr-review", "deploy"]);
  assert.equal(snap.adapterType, "openrouter");
  assert.equal(snap.supported, true);
  assert.equal(snap.mode, "ephemeral");
  assert.deepEqual(snap.desiredSkills, ["pr-review", "deploy"]);
  assert.equal(snap.entries.length, 3);

  const byKey = Object.fromEntries(snap.entries.map((e) => [e.key, e]));
  assert.equal(byKey["pr-review"]?.state, "configured");
  assert.equal(byKey["pr-review"]?.desired, true);
  assert.equal(byKey["triage"]?.state, "available");
  assert.equal(byKey["triage"]?.desired, false);
  assert.equal(byKey["deploy"]?.required, true);
  assert.equal(byKey["pr-review"]?.sourcePath, "/skills/pr-review.md");
});

test("buildSkillSnapshot with no selection -> all available, empty desired", () => {
  const snap = buildSkillSnapshot(entries, []);
  assert.deepEqual(snap.desiredSkills, []);
  assert.ok(snap.entries.every((e) => e.state === "available" && e.desired === false));
});

test("renderSkillsSection returns empty string when nothing is selected", () => {
  assert.equal(renderSkillsSection([]), "");
});

test("renderSkillsSection emits a ## Skills section with each skill body", () => {
  const out = renderSkillsSection([
    { key: "pr-review", content: "  Review PRs carefully.  " },
    { key: "deploy", content: "Run the deploy checklist." },
  ]);
  assert.match(out, /^## Skills/);
  assert.match(out, /### Skill: pr-review/);
  assert.match(out, /Review PRs carefully\./);
  assert.match(out, /### Skill: deploy/);
  assert.match(out, /Run the deploy checklist\./);
  // content is trimmed
  assert.ok(!out.includes("  Review PRs carefully.  "));
});
