/**
 * OpenRouter credit-balance reporting.
 *
 * Surfaces remaining prepaid credits to Paperclip's quota dashboard via the
 * adapter `getQuotaWindows()` hook. Reads the API key from the host
 * environment (OPENROUTER_API_KEY) since the hook has no per-agent context.
 */
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import { DEFAULT_OPENROUTER_BASE_URL } from "../index.js";

// Coerce arbitrary JSON to a finite number or null. Rejects NaN/Infinity so
// downstream math (percentages, remaining balance) never produces garbage.
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Render a USD amount. Drop the cents for large balances (>= $100) to keep the
// dashboard label compact; small balances keep two decimals for precision.
function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export async function getOpenRouterQuotaWindows(): Promise<ProviderQuotaResult> {
  // Credentials and endpoint come from the host env (no per-agent context here);
  // base URL is normalized to strip any trailing slash before appending paths.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  const baseUrl = (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, "");
  // Without a key we can't query the account; return a structured not-ok result
  // (rather than throwing) so the dashboard can show the reason cleanly.
  if (!apiKey) {
    return {
      provider: "openrouter",
      source: "openrouter:/auth/key",
      ok: false,
      error: "OPENROUTER_API_KEY is not set in the host environment.",
      windows: [],
    };
  }
  // Bound the call to 10s so a slow/hung request surfaces as a timeout error
  // instead of blocking the quota dashboard.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // /auth/key returns metadata about the calling key: usage, spend limit, and
    // tier — the source of the credit-balance figures below.
    const res = await fetch(`${baseUrl}/auth/key`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    // Read as text first so a non-ok body can be echoed back in the error.
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
    // Response payload is wrapped in a `data` object. Each numeric field is
    // optional — OpenRouter omits `limit`/`limit_remaining` for keys with no
    // cap — so every read is null-tolerant.
    const parsed = JSON.parse(text) as { data?: Record<string, unknown> };
    const data = parsed.data ?? {};
    const usage = asNumber(data.usage);
    const limit = asNumber(data.limit);
    const limitRemaining = asNumber(data.limit_remaining);
    const isFreeTier = data.is_free_tier === true;

    // Prefer the server-reported remaining balance; otherwise derive it from
    // limit - usage when both are known. Stays null for uncapped keys.
    const remaining = limitRemaining ?? (limit !== null && usage !== null ? limit - usage : null);
    // Percentage of the credit limit consumed, clamped to [0, 100] to absorb
    // rounding or over-spend. Undefined without a positive limit and a usage
    // figure (e.g. uncapped keys have no meaningful percentage).
    const usedPercent =
      limit !== null && limit > 0 && usage !== null
        ? Math.max(0, Math.min(100, (usage / limit) * 100))
        : null;

    // Headline figure: show remaining credits when known, else fall back to
    // amount used, else nothing (e.g. uncapped key with no usage reported).
    const valueLabel =
      remaining !== null
        ? `${formatUsd(remaining)} remaining`
        : usage !== null
          ? `${formatUsd(usage)} used`
          : null;

    // Secondary detail line, assembled from whichever facts are available and
    // joined with a middot. Explicitly note when no limit is configured.
    const detailParts: string[] = [];
    if (usage !== null) detailParts.push(`used ${formatUsd(usage)}`);
    if (limit !== null) detailParts.push(`limit ${formatUsd(limit)}`);
    else detailParts.push("no credit limit set");
    if (isFreeTier) detailParts.push("free tier");

    // Map onto Paperclip's QuotaWindow. resetsAt is null because prepaid
    // credits don't roll over on a schedule (unlike rate-limit windows).
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
    // Distinguish a timeout (from the AbortController above) from other
    // network/parse failures so the dashboard can show a precise message.
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      provider: "openrouter",
      source: "openrouter:/auth/key",
      ok: false,
      error: aborted ? "OpenRouter /auth/key timed out." : err instanceof Error ? err.message : String(err),
      windows: [],
    };
  } finally {
    // Always clear the abort timer so it doesn't fire (or leak) after the
    // request settles on either the success or error path.
    clearTimeout(timer);
  }
}
