import type { EnrichmentResult } from "../types";

// Bump the suffix when changing fetch behavior (e.g., new DNR headers) so
// previously cached `blocked` / `error` results don't short-circuit retries.
const STORAGE_KEY = "peopleLookup_v3";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Disable the cache while iterating on fetch behavior. Flip back to false
// once lookups are landing reliably so we stop hammering the sites.
const CACHE_DISABLED = false;

interface Entry {
  result: EnrichmentResult;
  fetchedAtMs: number;
}

type Bucket = Record<string, Entry>;

async function readBucket(): Promise<Bucket> {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  const raw = got?.[STORAGE_KEY];
  return raw && typeof raw === "object" ? (raw as Bucket) : {};
}

export function keyFor(
  first: string,
  last: string,
  city: string,
  state: string
): string {
  return [first, last, city, state]
    .map((s) => s.trim().toLowerCase())
    .join("|");
}

export async function getCached(
  key: string
): Promise<EnrichmentResult | null> {
  if (CACHE_DISABLED) return null;
  try {
    const bucket = await readBucket();
    const entry = bucket[key];
    if (!entry) return null;
    if (Date.now() - entry.fetchedAtMs > TTL_MS) return null;
    return entry.result;
  } catch {
    return null;
  }
}

export async function setCached(
  key: string,
  result: EnrichmentResult
): Promise<void> {
  if (CACHE_DISABLED) return;
  // Only persist successful matches. Caching no_match / blocked / error
  // bakes in transient or parser-induced misses for the full TTL, which
  // makes selector iteration painful — let those statuses retry every
  // time instead.
  if (result.status !== "ok") return;
  try {
    const bucket = await readBucket();
    bucket[key] = { result, fetchedAtMs: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEY]: bucket });
  } catch {
    /* swallow — cache is best-effort */
  }
}
