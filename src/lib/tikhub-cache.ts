import { promises as fs } from "fs";
import type { CreatorVideoStats } from "./tikhub";

// TikHub creator analytics cache: one gitignored JSON file at the project
// root, refreshed at most once per 24 hours via the analytics page's Sync
// button. Shared by the sync route (writes) and the videos route (reads).
import { TIKHUB_CACHE_PATH as CACHE_PATH } from "./paths";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface TikHubCacheEntry {
  videos: CreatorVideoStats[];
  cachedAt: number;
  cacheExpiresAt: number;
}

// allowStale lets error paths fall back to expired data
export async function readTikhubCache(
  allowStale = false
): Promise<TikHubCacheEntry | null> {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    const cache = JSON.parse(raw) as TikHubCacheEntry;
    if (allowStale || cache.cacheExpiresAt > Date.now()) return cache;
  } catch {
    // Cache miss or corrupted — treat as null
  }
  return null;
}

export async function writeTikhubCache(
  videos: CreatorVideoStats[]
): Promise<TikHubCacheEntry> {
  const entry: TikHubCacheEntry = {
    videos,
    cachedAt: Date.now(),
    cacheExpiresAt: Date.now() + CACHE_TTL_MS,
  };
  await fs.writeFile(CACHE_PATH, JSON.stringify(entry), "utf8");
  return entry;
}
