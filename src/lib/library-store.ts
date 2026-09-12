import { promises as fs } from "fs";
import { extname, join } from "path";
import { randomUUID } from "crypto";
import { LIBRARY_DIR, LIBRARY_METADATA_FILE } from "./paths";
import {
  ClipLibraryZ,
  VIDEO_EXTENSIONS,
  type ClipLibrary,
  type LibraryClip,
} from "./library-schema";

// The one reader/writer of <libraryDir>/.metadata.json. Everything that
// needs the clip catalog goes through here so the legacy-field upgrade
// below applies everywhere.

function emptyLibrary(): ClipLibrary {
  return { videos: [], lastUpdated: new Date().toISOString() };
}

const state = globalThis as typeof globalThis & { libraryWrite?: Promise<unknown> };
export async function withLibraryLock<T>(action: () => Promise<T>): Promise<T> {
  const task = (state.libraryWrite ?? Promise.resolve()).catch(() => {}).then(action);
  state.libraryWrite = task;
  try { return await task; } finally { if (state.libraryWrite === task) state.libraryWrite = undefined; }
}

export class LibraryRecoveryError extends Error {
  constructor() { super("The clip catalog could not be read. Your footage and catalog have been preserved. Restore the last valid backup or repair the catalog before saving."); }
}

// Older metadata files named the presence fields after the brand
// (e.g. "<brand>_present" / "<brand>_note"). Fold them into the neutral
// product_present / product_note so existing libraries keep working.
function upgradeLegacyFields(raw: unknown): { library: ClipLibrary; migrated: boolean } {
  let migrated = false;
  const data = raw as { videos?: Array<Record<string, unknown>> };
  for (const video of data?.videos ?? []) {
    const analysis = video.analysis as Record<string, unknown> | null | undefined;
    if (!analysis || typeof analysis !== "object") continue;
    if ("product_present" in analysis) continue;
    const legacyKey = Object.keys(analysis).find(
      (k) => /^[a-z0-9]+_present$/.test(k) && k !== "product_present"
    );
    if (!legacyKey) continue;
    const prefix = legacyKey.slice(0, -"_present".length);
    analysis.product_present = analysis[legacyKey];
    analysis.product_note = analysis[`${prefix}_note`] ?? "";
    delete analysis[legacyKey];
    delete analysis[`${prefix}_note`];
    migrated = true;
  }
  return { library: ClipLibraryZ.parse(data), migrated };
}

export async function loadLibrary(): Promise<ClipLibrary> {
  let raw: string;
  try {
    raw = await fs.readFile(LIBRARY_METADATA_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLibrary();
    throw new LibraryRecoveryError();
  }
  try {
    const { library } = upgradeLegacyFields(JSON.parse(raw));
    return library;
  } catch (error) {
    console.error(`[library] Could not parse ${LIBRARY_METADATA_FILE}:`, error);
    throw new LibraryRecoveryError();
  }
}

export async function saveLibrary(library: ClipLibrary): Promise<void> {
  await fs.mkdir(LIBRARY_DIR, { recursive: true });
  const next = JSON.stringify(ClipLibraryZ.parse(library), null, 2);
  try {
    const previous = await fs.readFile(LIBRARY_METADATA_FILE, "utf8");
    try { upgradeLegacyFields(JSON.parse(previous)); } catch { throw new LibraryRecoveryError(); }
    const backup = `${LIBRARY_METADATA_FILE}.${randomUUID()}.backup.tmp`;
    await fs.writeFile(backup, previous);
    await fs.rename(backup, `${LIBRARY_METADATA_FILE}.bak`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const tmp = `${LIBRARY_METADATA_FILE}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, next); await fs.rename(tmp, LIBRARY_METADATA_FILE); }
  finally { await fs.unlink(tmp).catch(() => {}); }
}

export async function restoreLibraryBackup(): Promise<void> {
  await withLibraryLock(async () => {
    const backup = await fs.readFile(`${LIBRARY_METADATA_FILE}.bak`, "utf8");
    upgradeLegacyFields(JSON.parse(backup));
    const original = await fs.readFile(LIBRARY_METADATA_FILE, "utf8");
    await fs.writeFile(`${LIBRARY_METADATA_FILE}.preserved-${randomUUID()}`, original);
    const temp = `${LIBRARY_METADATA_FILE}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, backup);
    await fs.rename(temp, LIBRARY_METADATA_FILE);
  });
}

export function isVideoFilename(filename: string): boolean {
  return (
    !filename.startsWith(".") &&
    (VIDEO_EXTENSIONS as readonly string[]).includes(
      extname(filename).toLowerCase()
    )
  );
}

// Video files currently in the library folder (hidden files excluded)
export async function listLibraryFiles(): Promise<string[]> {
  const files = await fs.readdir(LIBRARY_DIR).catch(() => [] as string[]);
  return files.filter(isVideoFilename);
}

export async function findLibraryFile(filename: string): Promise<string | null> {
  const files = await fs.readdir(LIBRARY_DIR).catch(() => [] as string[]);
  return files.includes(filename) ? join(LIBRARY_DIR, filename) : null;
}

// Files on disk merged with stored metadata: every video gets an entry
export async function scanLibrary(): Promise<ClipLibrary> {
  await fs.mkdir(LIBRARY_DIR, { recursive: true });
  const videoFiles = await listLibraryFiles();
  const metadata = await loadLibrary();
  const metadataMap = new Map(metadata.videos.map((v) => [v.filename, v]));
  const now = new Date().toISOString();

  const videos: LibraryClip[] = videoFiles.map(
    (filename) =>
      metadataMap.get(filename) ?? {
        filename,
        date: undefined,
        tags: [],
        description: undefined,
        source: undefined,
        duration: undefined,
        createdAt: now,
        updatedAt: now,
      }
  );

  return { videos, lastUpdated: now };
}
