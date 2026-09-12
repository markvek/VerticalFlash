import { randomUUID } from "crypto";
import { exportPaths } from "./export-state";
import { withProjectEdit } from "./project-edit-lock";
import { promises as fs } from "fs";
import { PUBLISH_STORE_PATH, sidecarPath } from "./paths";
import { z } from "zod";
import { renderManifestPath } from "./render-remake";

// Append-only log of TikTok uploads: publishes.json (project root, gitignored).
// Each upload snapshots the render facts + caption options at upload time so a
// published post can later be matched back to the exact render version it came
// from — the manifest and captions files get overwritten by re-renders.

export const PublishRecordZ = z.object({
  videoId: z.string(),
  exportId: z.string().optional(),
  sourceVideo: z.string().nullable().optional(),
  // Render version uploaded (1 until versioning lands; manifests without a
  // version field are implicitly v1)
  version: z.number(),
  publishId: z.string(),
  uploadedAt: z.string(),
  // Snapshot of the render manifest at upload time (null = manifest unreadable)
  renderedAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  // Caption texts offered for this video — the user pastes one of these when
  // posting the draft, which makes them a strong matching signal
  captionOptions: z.array(z.string()),
  // TikTok publish status when the upload route returned
  status: z.string(),
});

export type PublishRecord = z.infer<typeof PublishRecordZ>;

export const PublishStoreZ = z.object({
  version: z.literal(1),
  publishes: z.array(PublishRecordZ),
});

export type PublishStore = z.infer<typeof PublishStoreZ>;

const EMPTY_STORE: PublishStore = { version: 1, publishes: [] };

function storePath(): string {
  return PUBLISH_STORE_PATH;
}

export async function readPublishStore(): Promise<PublishStore> {
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    return PublishStoreZ.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The upload history could not be read. Preserve and repair publishes.json before saving.");
    return structuredClone(EMPTY_STORE);
  }
}

async function appendPublishRecord(record: PublishRecord): Promise<void> {
  await withProjectEdit("publish-history", async () => {
  const store = await readPublishStore();
  store.publishes.push(PublishRecordZ.parse(record));
  const path = storePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, path);
  });
}

// Record a successful upload, snapshotting the render manifest and caption
// options. Best-effort by design: this runs after TikTok has accepted the
// video, so a failure here must never fail the upload — it only costs one
// future auto-match suggestion.
export async function recordPublish(opts: {
  videoId: string;
  publishId: string;
  status: string;
  exportId?: string;
}): Promise<void> {
  try {
    let version = 1;
    let sourceVideo: string | null = null;
    let renderedAt: string | null = null;
    let durationSeconds: number | null = null;
    try {
      const raw = await fs.readFile(opts.exportId ? exportPaths(opts.videoId, opts.exportId).manifest : renderManifestPath(opts.videoId), "utf8");
      const manifest = JSON.parse(raw);
      sourceVideo = manifest.sourceVideo ?? null;
      if (typeof manifest?.version === "number") version = manifest.version;
      if (typeof manifest?.renderedAt === "string")
        renderedAt = manifest.renderedAt;
      if (typeof manifest?.durationSeconds === "number")
        durationSeconds = manifest.durationSeconds;
    } catch {
      // no manifest — record the upload anyway
    }

    let captionOptions: string[] = [];
    try {
      const captionsFile = sidecarPath(opts.videoId, "captions");
      const captions = JSON.parse(await fs.readFile(captionsFile, "utf8"));
      if (Array.isArray(captions?.captions)) {
        captionOptions = captions.captions
          .map((c: unknown) =>
            typeof (c as { text?: unknown })?.text === "string"
              ? (c as { text: string }).text
              : null
          )
          .filter((t: string | null): t is string => t !== null);
      }
    } catch {
      // no captions generated for this video
    }

    await appendPublishRecord({
      videoId: opts.videoId,
      exportId: opts.exportId, sourceVideo,
      version,
      publishId: opts.publishId,
      uploadedAt: new Date().toISOString(),
      renderedAt,
      durationSeconds,
      captionOptions,
      status: opts.status,
    });
  } catch (error) {
    console.error("Failed to record publish (upload unaffected):", error);
  }
}

export async function updatePublishStatus(publishId: string, status: string) {
  await withProjectEdit("publish-history", async () => {
    const store = await readPublishStore(); const record = store.publishes.find(r => r.publishId === publishId);
    if (!record) throw new Error("Upload record not found");
    record.status = status;
    const temp = `${storePath()}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(store, null, 2)); await fs.rename(temp, storePath());
  });
}
