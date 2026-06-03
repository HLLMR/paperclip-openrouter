/**
 * Environment diagnostics for the openrouter adapter.
 *
 * Validates the API key, surfaces remaining credit balance, checks the
 * configured model against the live catalog, and runs a short hello probe.
 */
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MODEL, DEFAULT_OPENROUTER_BASE_URL } from "../index.js";
import { isAuthError, parseOpenRouterResponse } from "./parse.js";
import { fetchOpenRouterModels } from "./models.js";
import { getOpenRouterQuotaWindows } from "./quota.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function resolveEnvValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (record && record.type === "plain" && typeof record.value === "string") return record.value;
  return null;
}

function readApiKey(config: Record<string, unknown>, env: Record<string, string>): string {
  const fromConfig = asString(config.apiKey, "").trim();
  if (fromConfig) return fromConfig;
  return (env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "").trim();
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const baseUrl = (asString(config.apiBaseUrl, DEFAULT_OPENROUTER_BASE_URL) || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, "");
  const model = (asString(config.model, DEFAULT_MODEL) || DEFAULT_MODEL).trim();

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    const resolved = resolveEnvValue(value);
    if (resolved !== null) env[key] = resolved;
  }
  const apiKey = readApiKey(config, env);

  if (!apiKey) {
    checks.push({
      code: "openrouter_api_key_missing",
      level: "error",
      message: "OpenRouter API key is not configured.",
      hint: "Set apiKey in adapter config, or provide OPENROUTER_API_KEY in adapter env / host environment.",
    });
  } else {
    checks.push({ code: "openrouter_api_key_present", level: "info", message: "OpenRouter API key is configured." });
  }

  // Model validation against the live catalog (best-effort).
  if (apiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let catalog;
      try {
        catalog = await fetchOpenRouterModels(baseUrl, apiKey, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      if (catalog.length === 0) {
        checks.push({ code: "openrouter_models_empty", level: "warn", message: "OpenRouter returned an empty model catalog." });
      } else if (catalog.some((m) => m.id === model)) {
        checks.push({ code: "openrouter_model_available", level: "info", message: `Model is available on OpenRouter: ${model}` });
      } else {
        checks.push({
          code: "openrouter_model_not_found",
          level: "warn",
          message: `Configured model "${model}" was not found in the live OpenRouter catalog.`,
          hint: "Pick a model id from https://openrouter.ai/models (provider/model format).",
        });
      }
    } catch (err) {
      checks.push({
        code: "openrouter_models_fetch_failed",
        level: "warn",
        message: `Could not fetch the OpenRouter model catalog: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Credit balance (best-effort, informational).
  if (apiKey) {
    const prevKey = process.env.OPENROUTER_API_KEY;
    const prevBase = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_API_KEY = apiKey;
    process.env.OPENROUTER_BASE_URL = baseUrl;
    try {
      const quota = await getOpenRouterQuotaWindows();
      const window = quota.windows[0];
      if (quota.ok && window) {
        checks.push({
          code: "openrouter_credits",
          level: "info",
          message: `OpenRouter credits: ${window.valueLabel ?? "reported"}`,
          ...(window.detail ? { detail: window.detail } : {}),
        });
      }
    } catch {
      // non-fatal
    } finally {
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
      if (prevBase === undefined) delete process.env.OPENROUTER_BASE_URL;
      else process.env.OPENROUTER_BASE_URL = prevBase;
    }
  }

  // Hello probe.
  if (apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Title": "Paperclip OpenRouter Adapter (env probe)",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "Reply with the single word: hello." },
            { role: "user", content: "Respond with hello." },
          ],
          max_tokens: 16,
          temperature: 0,
        }),
        signal: controller.signal,
      });
      const bodyText = await res.text();
      if (!res.ok) {
        checks.push({
          code: isAuthError(res.status, bodyText) ? "openrouter_auth_failed" : "openrouter_probe_failed",
          level: "error",
          message: isAuthError(res.status, bodyText)
            ? `OpenRouter rejected the API key (status ${res.status}).`
            : `OpenRouter probe failed with status ${res.status}.`,
          detail: bodyText.slice(0, 240),
          ...(isAuthError(res.status, bodyText)
            ? { hint: "Verify the key at https://openrouter.ai/keys and ensure it has access to the chosen model." }
            : {}),
        });
      } else {
        let text = "";
        try {
          text = parseOpenRouterResponse(JSON.parse(bodyText)).text.trim();
        } catch {
          text = "";
        }
        const hasHello = /\bhello\b/i.test(text);
        checks.push({
          code: hasHello ? "openrouter_hello_probe_passed" : "openrouter_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello ? "OpenRouter probe succeeded." : "OpenRouter probe ran but did not return `hello` as expected.",
          ...(text ? { detail: text.slice(0, 240) } : {}),
        });
      }
    } catch (err) {
      checks.push({
        code: "openrouter_probe_error",
        level: "warn",
        message: err instanceof Error ? err.message : "OpenRouter probe failed",
        hint: "Check network access from the Paperclip host to the OpenRouter base URL.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
}
