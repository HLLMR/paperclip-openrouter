/**
 * Server module for the openrouter adapter.
 *
 * createServerAdapter() is the entry the Paperclip plugin loader calls. It
 * returns the full ServerAdapterModule: execution, environment test, session
 * persistence, live model catalog, and credit-balance quota reporting.
 */
import type {
  AdapterSessionCodec,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { type, models, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listOpenRouterModels } from "./models.js";
import { getOpenRouterQuotaWindows } from "./quota.js";

// Persisted session blobs are untrusted (round-tripped through storage), so the
// codec validates defensively rather than trusting shapes.

// Trim-and-null helper: treat blank/whitespace-only and non-string values as absent.
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Keep only well-formed object entries; drop null/primitive junk that may have
// crept into a stored message array.
function readMessages(raw: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
}

// Session codec: how a run's resumable state (sessionId + model + message
// history) is read from and written to Paperclip's session store. serialize and
// deserialize are intentionally symmetric so a round-trip is lossless.
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    // Reject anything that isn't a plain object up front.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    // sessionId is the only required field — without it there is nothing to resume.
    const sessionId = readNonEmptyString(record.sessionId);
    if (!sessionId) return null;
    const model = readNonEmptyString(record.model);
    const messages = readMessages(record.messages);
    // Omit model/messages entirely when absent so the stored shape stays minimal.
    return {
      sessionId,
      ...(model ? { model } : {}),
      ...(messages && messages.length > 0 ? { messages } : {}),
    };
  },
  serialize(params) {
    // Mirror of deserialize: same validation, so what we write is what we can read back.
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId);
    if (!sessionId) return null;
    const model = readNonEmptyString(params.model);
    const messages = readMessages(params.messages);
    return {
      sessionId,
      ...(model ? { model } : {}),
      ...(messages && messages.length > 0 ? { messages } : {}),
    };
  },
  // Short label Paperclip shows for the session — just the opaque sessionId.
  getDisplayId(params) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId);
  },
};

// Session-management policy advertised to Paperclip. We can resume sessions, but
// OpenRouter has no server-side context window management ("none"), so Paperclip
// must drive compaction — hence the explicit defaults below (run count, raw
// input-token ceiling, and age cap that trigger compaction).
export const sessionManagement: NonNullable<ServerAdapterModule["sessionManagement"]> = {
  supportsSessionResume: true,
  nativeContextManagement: "none",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 10,
    maxRawInputTokens: 200_000,
    maxSessionAgeHours: 24,
  },
};

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listOpenRouterModels } from "./models.js";
export { getOpenRouterQuotaWindows } from "./quota.js";

// Factory the plugin loader calls once to assemble the full adapter surface.
// Wires together: run execution, the environment self-test, session codec +
// management policy, the seed/live model catalog, and credit-balance quota
// reporting.
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    // `models` is the static seed catalog (shown immediately); `listModels`
    // fetches the live OpenRouter catalog that supersedes it at runtime.
    models,
    listModels: listOpenRouterModels,
    getQuotaWindows: getOpenRouterQuotaWindows,
    supportsLocalAgentJwt: true,
    agentConfigurationDoc,
  };
}
