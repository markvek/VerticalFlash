import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { ANALYSIS_DIR, sidecarPath } from "./paths";
import { emptyFraming, FramingDocumentZ, type FramingDocument } from "./framing-schema";

export async function readFraming(videoId: string): Promise<FramingDocument> {
  try {
    return FramingDocumentZ.parse(JSON.parse(await fs.readFile(sidecarPath(videoId, "framing"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFraming(videoId);
    throw error;
  }
}

const pending = new Map<string, Promise<unknown>>();
export function writeFraming(document: FramingDocument): Promise<FramingDocument> {
  const task = (pending.get(document.videoId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const current = await readFraming(document.videoId);
    if (current.revision !== document.revision) throw new Error("Framing changed in another editor. Reload before saving.");
    const stored = FramingDocumentZ.parse({ ...document, revision: current.revision + 1, updatedAt: new Date().toISOString() });
    await fs.mkdir(ANALYSIS_DIR, { recursive: true });
    const path = sidecarPath(document.videoId, "framing");
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(stored, null, 2));
      await fs.rename(temp, path);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
    return stored;
  });
  pending.set(document.videoId, task);
  void task.finally(() => { if (pending.get(document.videoId) === task) pending.delete(document.videoId); }).catch(() => {});
  return task;
}
