import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { MasterStoryboardsZ, type MasterStoryboards, type Storyboard } from "./segments-schema";
import { STORYBOARDS_DIR, sidecarPath } from "./paths";
import { isValidVideoId } from "./video-id";

const state = globalThis as typeof globalThis & { storyboardStoreLocks?: Map<string, Promise<unknown>> };
const locks = state.storyboardStoreLocks ??= new Map<string, Promise<unknown>>();

function projectDir(videoId: string): string {
  if (!isValidVideoId(videoId)) throw new Error("Invalid videoId");
  return join(STORYBOARDS_DIR, videoId);
}

function ideaPath(videoId: string, storyboardId: string): string {
  if (!/^[\w-]+$/.test(storyboardId)) throw new Error("Invalid storyboard ID");
  return join(projectDir(videoId), `${storyboardId}.json`);
}

async function readDocument(path: string): Promise<MasterStoryboards | null> {
  try {
    return MasterStoryboardsZ.parse(JSON.parse(await fs.readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, doc: MasterStoryboards): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(MasterStoryboardsZ.parse(doc), null, 2));
    await fs.rename(temporary, path);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function withLock<T>(videoId: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(videoId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  locks.set(videoId, next);
  try {
    return await next;
  } finally {
    if (locks.get(videoId) === next) locks.delete(videoId);
  }
}

function singleIdea(doc: MasterStoryboards, storyboard: Storyboard): MasterStoryboards {
  const accepted = doc.accepted?.[storyboard.id];
  return {
    ...doc,
    storyboards: [{ ...storyboard, revision: storyboard.revision ?? 1 }],
    accepted: accepted ? { [storyboard.id]: accepted } : {},
    editing_projects: {
      [storyboard.id]: doc.editing_projects?.[storyboard.id] ?? (accepted ? [accepted] : []),
    },
  };
}

// Read old sidecars without moving or deleting them. Individually saved ideas
// take precedence, so migration can resume after an interrupted write.
export async function readStoryboards(videoId: string): Promise<MasterStoryboards | null> {
  const directory = projectDir(videoId);
  const legacy = await readDocument(sidecarPath(videoId, "storyboards"));
  const names = await fs.readdir(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const records = await Promise.all(names.filter((name) => /^[\w-]+\.json$/.test(name))
    .map((name) => readDocument(join(directory, name))));
  const byId = new Map<string, MasterStoryboards>();
  for (const idea of legacy?.storyboards ?? []) byId.set(idea.id, singleIdea(legacy!, idea));
  for (const record of records) {
    if (!record) continue;
    if (record.videoId !== videoId || record.storyboards.length !== 1) {
      throw new Error("Invalid saved storyboard project");
    }
    byId.set(record.storyboards[0].id, record);
  }
  const ordered = [...byId.values()].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  const latest = ordered[0] ?? legacy;
  if (!latest) return null;
  return {
    ...latest,
    storyboards: ordered.flatMap((doc) => doc.storyboards),
    accepted: Object.assign({}, ...ordered.map((doc) => doc.accepted)),
    editing_projects: Object.assign({}, ...ordered.map((doc) => doc.editing_projects)),
  };
}

async function migrateLegacy(videoId: string): Promise<void> {
  await fs.mkdir(projectDir(videoId), { recursive: true });
  const legacy = await readDocument(sidecarPath(videoId, "storyboards"));
  for (const idea of legacy?.storyboards ?? []) {
    const path = ideaPath(videoId, idea.id);
    if (!(await readDocument(path))) await atomicWrite(path, singleIdea(legacy!, idea));
  }
}

// Generation adds new ideas. It never replaces an earlier generation.
export async function writeStoryboards(doc: MasterStoryboards): Promise<MasterStoryboards> {
  return withLock(doc.videoId, async () => {
    await migrateLegacy(doc.videoId);
    for (const idea of doc.storyboards) {
      const path = ideaPath(doc.videoId, idea.id);
      if (await readDocument(path)) throw new Error("Storyboard ID already exists");
      await atomicWrite(path, singleIdea(doc, idea));
    }
    return (await readStoryboards(doc.videoId))!;
  });
}

export async function updateSavedStoryboard(
  videoId: string,
  storyboardId: string,
  update: (doc: MasterStoryboards) => void
): Promise<MasterStoryboards | null> {
  return withLock(videoId, async () => {
    await migrateLegacy(videoId);
    const path = ideaPath(videoId, storyboardId);
    const doc = await readDocument(path);
    if (!doc) return null;
    const before = structuredClone(doc);
    update(doc);
    const changed = JSON.stringify(before.storyboards) !== JSON.stringify(doc.storyboards);
    if (changed) {
      const revision = before.storyboards[0].revision ?? 1;
      const revisions = join(projectDir(videoId), "revisions");
      await fs.mkdir(revisions, { recursive: true });
      await atomicWrite(join(revisions, `${storyboardId}-v${revision}.json`), before);
      doc.storyboards[0].revision = revision + 1;
      delete doc.accepted?.[storyboardId];
    }
    await atomicWrite(path, doc);
    return readStoryboards(videoId);
  });
}

export async function recordStoryboardEdit(videoId: string, storyboard: Storyboard, filename: string) {
  return updateSavedStoryboard(videoId, storyboard.id, (doc) => {
    const files = doc.editing_projects?.[storyboard.id] ?? [];
    doc.editing_projects = { ...doc.editing_projects, [storyboard.id]: [...new Set([...files, filename])] };
    // An edit finishing after a newer storyboard revision still belongs to its
    // original revision; do not mark the newer design as already accepted.
    if ((doc.storyboards[0].revision ?? 1) === (storyboard.revision ?? 1)) {
      doc.accepted = { ...doc.accepted, [storyboard.id]: filename };
    }
  });
}

export async function removeStoryboardEdit(videoId: string, storyboardId: string, filename: string) {
  return updateSavedStoryboard(videoId, storyboardId, (doc) => {
    doc.editing_projects = {
      ...doc.editing_projects,
      [storyboardId]: (doc.editing_projects?.[storyboardId] ?? []).filter((file) => file !== filename),
    };
    if (doc.accepted?.[storyboardId] === filename) delete doc.accepted[storyboardId];
  });
}
