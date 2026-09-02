import type { ScanResult } from "@/lib/tikhub";

export interface ScanSeeds {
  hashtags: string[];
  keywords: string[];
  competitors: string[];
  tiktokUrl?: string;
  minViews?: number;
}

export interface Scan {
  id: string;
  seeds: ScanSeeds;
  results: ScanResult;
  selectedCandidates: string[];
  parentScanId?: string;
  timestamp: number;
}

interface StorageData {
  version: number;
  nextScanNumber: number;
  scans: Scan[];
}

const STORAGE_KEY = "tiktok-scanner-scans";
const CURRENT_VERSION = 1;

function getDefaultStorage(): StorageData {
  return {
    version: CURRENT_VERSION,
    nextScanNumber: 1,
    scans: [],
  };
}

function loadFromStorage(): StorageData {
  if (typeof window === "undefined") {
    return getDefaultStorage();
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return getDefaultStorage();

    const parsed = JSON.parse(stored) as StorageData;
    if (parsed.version !== CURRENT_VERSION) {
      return getDefaultStorage();
    }

    return parsed;
  } catch (e) {
    console.error("Failed to load scans from localStorage:", e);
    return getDefaultStorage();
  }
}

function saveToStorage(data: StorageData): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error("Failed to save scans to localStorage:", e);
  }
}

export function generateScanId(): string {
  const storage = loadFromStorage();
  const id = `scan-${storage.nextScanNumber}`;
  storage.nextScanNumber += 1;
  saveToStorage(storage);
  return id;
}

export function loadAllScans(): Scan[] {
  return loadFromStorage().scans;
}

export function saveScan(scan: Scan): void {
  const storage = loadFromStorage();
  const existing = storage.scans.findIndex((s) => s.id === scan.id);
  if (existing >= 0) {
    storage.scans[existing] = scan;
  } else {
    storage.scans.push(scan);
  }
  saveToStorage(storage);
}

export function deleteScan(scanId: string): void {
  const storage = loadFromStorage();
  storage.scans = storage.scans.filter((s) => s.id !== scanId);
  saveToStorage(storage);
}

export function deleteAllScans(): void {
  const storage = getDefaultStorage();
  storage.nextScanNumber = 1;
  saveToStorage(storage);
}

export function exportScansJSON(scans: Scan[]): string {
  return JSON.stringify(
    {
      version: CURRENT_VERSION,
      exportedAt: new Date().toISOString(),
      scans,
    },
    null,
    2
  );
}

export function importScansJSON(json: string): Scan[] {
  try {
    const parsed = JSON.parse(json) as {
      version: number;
      scans: Scan[];
    };

    if (parsed.version !== CURRENT_VERSION) {
      throw new Error(
        `Incompatible version: ${parsed.version} (expected ${CURRENT_VERSION})`
      );
    }

    if (!Array.isArray(parsed.scans)) {
      throw new Error("Invalid scans array");
    }

    return parsed.scans;
  } catch (e) {
    throw new Error(
      `Failed to parse scan JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
