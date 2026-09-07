import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { BrollTrackZ, brollPath, emptyBrollTrack, type BrollTrack } from "./broll-schema";
import { ANALYSIS_DIR } from "./paths";

// analysis/<videoId>.broll.json — the short's B-roll track

export async function readBrollTrack(videoId: string): Promise<BrollTrack> {
  try {
    return BrollTrackZ.parse(JSON.parse(await fs.readFile(brollPath(videoId), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyBrollTrack(videoId);
    throw error;
  }
}

export async function writeBrollTrack(track: BrollTrack): Promise<BrollTrack> {
  const stored = BrollTrackZ.parse({ ...track, updatedAt: new Date().toISOString() });
  await fs.mkdir(ANALYSIS_DIR, { recursive: true });
  const path = brollPath(track.videoId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(stored, null, 2));
    await fs.rename(temporary, path);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return stored;
}
