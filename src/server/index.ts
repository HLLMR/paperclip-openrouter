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

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readMessages(raw: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId);
    if (!sessionId) return null;
    const model = readNonEmptyString(record.model);
    const messages = readMessages(record.messages);
    return {
      sessionId,
      ...(model ? { model } : {}),
      ...(messages && messages.length > 0 ? { messages } : {}),
    };
  },
  serialize(params) {
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
  getDisplayId(params) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId);
  },
};

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

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    listModels: listOpenRouterModels,
    getQuotaWindows: getOpenRouterQuotaWindows,
    supportsLocalAgentJwt: true,
    agentConfigurationDoc,
  };
}
