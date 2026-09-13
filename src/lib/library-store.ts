import { randomUUID } from "crypto";
import { withProjectEdit } from "./project-edit-lock";
import { promises as fs } from "fs";
import { extname, join } from "path";
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

export class LibraryRecoveryError extends Error {
  constructor() {
    super("Library metadata could not be read or validated. The original file was preserved. Restore .metadata.json from a valid .metadata.json.bak backup before saving.");
    this.name = "LibraryRecoveryError";
  }
}

export function withLibraryEdit<T>(work: () => Promise<T>): Promise<T> {
  return withProjectEdit("library-metadata", work);
}

async function readCatalog(): Promise<{ raw: string; library: ClipLibrary } | null> {
  let raw: string;
  try { raw = await fs.readFile(LIBRARY_METADATA_FILE, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LibraryRecoveryError();
  }
  try { return { raw, library: upgradeLegacyFields(JSON.parse(raw)).library }; }
  catch { throw new LibraryRecoveryError(); }
}

export async function loadLibrary(): Promise<ClipLibrary> {
  return (await readCatalog())?.library ?? emptyLibrary();
}

export async function saveLibrary(library: ClipLibrary): Promise<void> {
  const validated = ClipLibraryZ.parse(library);
  await fs.mkdir(LIBRARY_DIR, { recursive: true });
  // Never replace an unreadable catalog, including saves from stale callers.
  const previous = await readCatalog();
  const tmp = `${LIBRARY_METADATA_FILE}.${randomUUID()}.tmp`;
  const backupTmp = `${tmp}.bak`;
  try {
    if (previous) {
      await fs.writeFile(backupTmp, previous.raw);
      await fs.rename(backupTmp, `${LIBRARY_METADATA_FILE}.bak`);
    }
    await fs.writeFile(tmp, JSON.stringify(validated, null, 2));
    await fs.rename(tmp, LIBRARY_METADATA_FILE);
  } finally {
    await fs.rm(tmp, { force: true });
    await fs.rm(backupTmp, { force: true });
  }
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
