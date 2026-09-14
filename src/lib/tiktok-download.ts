import { promises as fs } from "fs";
import { join } from "path";
import { DOWNLOADS_DIR } from "./paths";
import { findDownloadFile } from "./download-files";
import { fetchVideoDetail, harvestAppVideoItem } from "./tikhub";
import { atomicReferenceJson } from "./reference-import";
import { randomUUID } from "crypto";

export async function saveTikTokVideo(videoId: string, filename: string) {
  if (!/^\d+$/.test(videoId) || !/^[\w-]+\.mp4$/.test(filename)) throw new Error("Invalid download name");
  const existing = await findDownloadFile(videoId);
  if (existing) return existing;
  const detail = await fetchVideoDetail(videoId);
  const upstream = await fetch(detail.video.play_addr.url_list[0], { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!upstream.ok) throw new Error(`Video download failed (${upstream.status})`);
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (!bytes.length) throw new Error("Downloaded video is empty");
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  const path = join(DOWNLOADS_DIR, filename);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes);
    const { probeDuration } = await import("./master-assemble");
    if (!await probeDuration(temporary)) throw new Error("Downloaded file is not a playable video");
    const harvested = harvestAppVideoItem(detail);
    await atomicReferenceJson(`${path}.metadata.json`, { ...harvested.video,
      authorFollowerCount: harvested.authorFollowerCount, musicId: harvested.musicId,
      musicTitle: harvested.musicTitle, musicAuthor: detail.music?.author, coTags: harvested.coTags,
      sourceUrl: `https://www.tiktok.com/@${harvested.video.authorHandle}/video/${videoId}`, savedAt: new Date().toISOString() });
    await fs.rename(temporary, path);
    return { filename, path };
  } finally { await fs.rm(temporary, { force: true }); }
}
