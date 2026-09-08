import { promises as fs } from "fs";
import { join } from "path";
import { DATA_ROOT, getBrandConfig } from "./config";

export { DATA_ROOT };

// Shipped connector files belong to the application, independent of DATA_DIR.
export const AGENT_KIT_DIR = join(process.cwd(), "agent-kit");

// Every on-disk location the app uses, in one place. All of these are
// gitignored (or live outside the repo when DATA_DIR is set).
export const DOWNLOADS_DIR = join(DATA_ROOT, "downloads");
export const STORYBOARDS_DIR = join(DATA_ROOT, "storyboards");
export const EDITING_DIR = join(DATA_ROOT, "editing");
export const PROJECT_MEDIA_DIRS = [DOWNLOADS_DIR, STORYBOARDS_DIR, EDITING_DIR] as const;
export const ANALYSIS_DIR = join(DATA_ROOT, "analysis");
export const RENDERS_DIR = join(DATA_ROOT, "renders");
export const GENERATED_DIR = join(DATA_ROOT, "generated");
export const MUSIC_DIR = join(DATA_ROOT, "music");

// The brand's clip library (folder name comes from brand.config.json)
export const LIBRARY_DIR = join(DATA_ROOT, getBrandConfig().libraryDir);
export const LIBRARY_METADATA_FILE = join(LIBRARY_DIR, ".metadata.json");
export const LIBRARY_THUMBS_DIR = join(LIBRARY_DIR, ".thumbs");

// Single-user JSON stores
export const PUBLISH_STORE_PATH = join(DATA_ROOT, "publishes.json");
export const TIKHUB_CACHE_PATH = join(DATA_ROOT, "tikhub-cache.json");
export const TIKTOK_TOKEN_PATH = join(DATA_ROOT, "tiktok-token.json");
export const AGENT_SETTINGS_PATH = join(DATA_ROOT, "agent-settings.json");

export const DATA_DIRS = [
  DOWNLOADS_DIR,
  STORYBOARDS_DIR,
  EDITING_DIR,
  ANALYSIS_DIR,
  RENDERS_DIR,
  GENERATED_DIR,
  MUSIC_DIR,
  LIBRARY_DIR,
] as const;

// Per-video sidecar files under analysis/
export function analysisPath(videoId: string): string {
  return join(ANALYSIS_DIR, `${videoId}.json`);
}

export function sidecarPath(videoId: string, kind: string): string {
  return join(ANALYSIS_DIR, `${videoId}.${kind}.json`);
}

export function libraryClipPath(filename: string): string {
  return join(LIBRARY_DIR, filename);
}

let ensured: Promise<void> | undefined;

// Create every data directory (idempotent). Called once at server start
// from instrumentation.ts and at the top of CLI scripts.
export function ensureDataDirs(): Promise<void> {
  ensured ??= Promise.all(
    DATA_DIRS.map((dir) => fs.mkdir(dir, { recursive: true }))
  ).then(() => undefined);
  return ensured;
}
