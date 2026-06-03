/**
 * Live OpenRouter model catalog.
 *
 * Unlike a provider-locked adapter, this returns the FULL OpenRouter catalog
 * (300+ models across providers) so operators can pick any model from the
 * Paperclip agent UI. Falls back to the seed list in ../index.ts when the
 * network is unavailable. Cached for 5 minutes.
 */
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { DEFAULT_OPENROUTER_BASE_URL, models as seedModels } from "../index.js";

// The OpenRouter catalog changes slowly, so cache for 5 minutes to avoid
// hammering /models every time Paperclip opens the model picker.
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

// Process-wide cache shared across all callers. `fetchedAt` is the wall-clock
// time of the last successful fetch; entries older than the TTL are refetched.
let cache: { fetchedAt: number; models: AdapterModel[] } | null = null;

// Test hook: clears the module-level cache so each test starts cold. Not part
// of the public adapter surface.
export function resetOpenRouterModelsCacheForTests(): void {
  cache = null;
}

// Coerce arbitrary JSON into a trimmed non-empty string, or null. Used to
// defensively read fields from the untyped /models payload.
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Resolve the API base URL, allowing an env override (e.g. a proxy/gateway)
// while defaulting to the canonical OpenRouter endpoint. Trailing slash is
// stripped so callers can safely append "/models" etc.
function resolveBaseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, "");
}

// Low-level fetch of the live catalog. Pure HTTP + normalization with no
// caching or fallback — `listOpenRouterModels` layers those on top. Exported
// so tests (and callers wanting an explicit base/key) can drive it directly.
export async function fetchOpenRouterModels(
  baseUrl: string,
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<AdapterModel[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "paperclip-openrouter",
  };
  // /models is publicly readable, so the key is optional; when present it lets
  // OpenRouter scope the catalog to the account (e.g. honoring allow-lists).
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { method: "GET", headers, signal });
  if (!res.ok) {
    // Surface HTTP failures as thrown errors; the caller decides whether to
    // swallow them and fall back to the seed list.
    throw new Error(`OpenRouter /models returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data?: unknown };
  // Treat a missing/malformed `data` array as an empty catalog rather than
  // throwing — keeps parsing tolerant of upstream shape drift.
  const entries = Array.isArray(body.data) ? body.data : [];
  const out: AdapterModel[] = [];
  // Guard against duplicate ids in the upstream response.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const id = asString(rec.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Prefer the human-readable name for the picker label, falling back to the
    // id when absent.
    out.push({ id, label: asString(rec.name) ?? id });
  }
  // Sort by id with natural/numeric ordering so the picker is stable and
  // groups versioned models (e.g. gpt-4 before gpt-40) intuitively.
  out.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
  return out;
}

// Public entry point Paperclip calls to populate the model picker. Layers
// caching, a request timeout, and seed-list fallback over the raw fetch so the
// UI always gets a usable list even offline or without a key.
export async function listOpenRouterModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  // Serve from cache while still fresh.
  if (cache && now - cache.fetchedAt < MODELS_CACHE_TTL_MS) return cache.models;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  // Bound the network call: abort after 10s so a hung request degrades to the
  // seed list instead of stalling the picker.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const fetched = await fetchOpenRouterModels(resolveBaseUrl(), apiKey, controller.signal);
    // Only cache/return a non-empty result; an empty list (parsed but no usable
    // ids) is treated as a failure and falls through to seeds.
    if (fetched.length > 0) {
      cache = { fetchedAt: now, models: fetched };
      return fetched;
    }
  } catch {
    // Swallow — fall through to seed models.
  } finally {
    clearTimeout(timer);
  }
  // Offline / no-key / empty-response fallback: the curated seed list from
  // ../index.ts keeps the picker functional.
  return seedModels;
}
