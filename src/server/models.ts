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

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { fetchedAt: number; models: AdapterModel[] } | null = null;

export function resetOpenRouterModelsCacheForTests(): void {
  cache = null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveBaseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, "");
}

export async function fetchOpenRouterModels(
  baseUrl: string,
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<AdapterModel[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "envora-paperclip-adapter-openrouter",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { method: "GET", headers, signal });
  if (!res.ok) {
    throw new Error(`OpenRouter /models returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data?: unknown };
  const entries = Array.isArray(body.data) ? body.data : [];
  const out: AdapterModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const id = asString(rec.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: asString(rec.name) ?? id });
  }
  out.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
  return out;
}

export async function listOpenRouterModels(): Promise<AdapterModel[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < MODELS_CACHE_TTL_MS) return cache.models;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const fetched = await fetchOpenRouterModels(resolveBaseUrl(), apiKey, controller.signal);
    if (fetched.length > 0) {
      cache = { fetchedAt: now, models: fetched };
      return fetched;
    }
  } catch {
    // Swallow — fall through to seed models.
  } finally {
    clearTimeout(timer);
  }
  return seedModels;
}
