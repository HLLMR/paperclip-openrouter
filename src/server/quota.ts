/**
 * OpenRouter credit-balance reporting.
 *
 * Surfaces remaining prepaid credits to Paperclip's quota dashboard via the
 * adapter `getQuotaWindows()` hook. Reads the API key from the host
 * environment (OPENROUTER_API_KEY) since the hook has no per-agent context.
 */
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import { DEFAULT_OPENROUTER_BASE_URL } from "../index.js";

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export async function getOpenRouterQuotaWindows(): Promise<ProviderQuotaResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  const baseUrl = (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, "");
  if (!apiKey) {
    return {
      provider: "openrouter",
      source: "openrouter:/auth/key",
      ok: false,
      error: "OPENROUTER_API_KEY is not set in the host environment.",
      windows: [],
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${baseUrl}/auth/key`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        provider: "openrouter",
        source: "openrouter:/auth/key",
        ok: false,
        error: `OpenRouter /auth/key returned ${res.status}: ${text.slice(0, 160)}`,
        windows: [],
      };
    }
    const parsed = JSON.parse(text) as { data?: Record<string, unknown> };
    const data = parsed.data ?? {};
    const usage = asNumber(data.usage);
    const limit = asNumber(data.limit);
    const limitRemaining = asNumber(data.limit_remaining);
    const isFreeTier = data.is_free_tier === true;

    const remaining = limitRemaining ?? (limit !== null && usage !== null ? limit - usage : null);
    const usedPercent =
      limit !== null && limit > 0 && usage !== null
        ? Math.max(0, Math.min(100, (usage / limit) * 100))
        : null;

    const valueLabel =
      remaining !== null
        ? `${formatUsd(remaining)} remaining`
        : usage !== null
          ? `${formatUsd(usage)} used`
          : null;

    const detailParts: string[] = [];
    if (usage !== null) detailParts.push(`used ${formatUsd(usage)}`);
    if (limit !== null) detailParts.push(`limit ${formatUsd(limit)}`);
    else detailParts.push("no credit limit set");
    if (isFreeTier) detailParts.push("free tier");

    const window: QuotaWindow = {
      label: "Credits",
      usedPercent,
      resetsAt: null,
      valueLabel,
      detail: detailParts.join(" · "),
    };

    return {
      provider: "openrouter",
      source: "openrouter:/auth/key",
      ok: true,
      windows: [window],
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      provider: "openrouter",
      source: "openrouter:/auth/key",
      ok: false,
      error: aborted ? "OpenRouter /auth/key timed out." : err instanceof Error ? err.message : String(err),
      windows: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
