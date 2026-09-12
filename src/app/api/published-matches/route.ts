import { readPublishedLinks, savePublishedLink } from "@/lib/published-links";
import { exportPaths } from "@/lib/export-state";
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { z } from "zod";
import { RENDERS_DIR } from "@/lib/render-remake";
import { readPublishStore } from "@/lib/publish-store";
import {
  matchPublished,
  type PublishedFacts,
  type RenderCandidate,
} from "@/lib/match-published";
import { isValidVideoId } from "@/lib/video-id";
import { ANALYSIS_DIR, DOWNLOADS_DIR } from "@/lib/paths";
import { resolveProjectFile } from "@/lib/download-files";


const BodyZ = z.object({
  videos: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        duration: z.number(),
        createTime: z.number(),
      })
    )
    .max(1000),
});

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// Build one candidate per render manifest on disk, skipping manifests whose
// source download has since been deleted (their page would 404)
async function loadCandidates(): Promise<RenderCandidate[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(RENDERS_DIR);
  } catch {
    return [];
  }

  const store = await readPublishStore();
  const candidates: RenderCandidate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".render.json")) continue;
    const manifest = (await readJson(join(RENDERS_DIR, entry))) as {
      videoId?: unknown;
      sourceVideo?: unknown;
      durationSeconds?: unknown;
      renderedAt?: unknown;
      exportId?: string;
    } | null;
    if (
      typeof manifest?.videoId !== "string" ||
      !isValidVideoId(manifest.videoId) ||
      typeof manifest.sourceVideo !== "string" ||
      typeof manifest.durationSeconds !== "number" ||
      typeof manifest.renderedAt !== "string"
    )
      continue;

    try {
      if (!(await resolveProjectFile(manifest.sourceVideo))) continue;
    } catch {
      continue;
    }

    const historical = store.publishes.filter(r => r.videoId === manifest.videoId && r.status !== "FAILED");
    for (const record of historical) {
      if (record.durationSeconds == null || !record.renderedAt) continue;
      candidates.push({ videoId: manifest.videoId, filename: record.sourceVideo ?? manifest.sourceVideo,
        durationSeconds: record.durationSeconds, renderedAt: record.renderedAt,
        captionOptions: record.captionOptions, uploadedAt: record.uploadedAt, exportId: record.exportId });
    }
    const exportDir = join(RENDERS_DIR, manifest.videoId, "exports");
    const archives = await fs.readdir(exportDir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const file of archives.filter(f => f.endsWith(".json"))) {
      const saved = await readJson(join(exportDir, file)) as { exportId?: string; renderedAt?: string; durationSeconds?: number; sourceVideo?: string } | null;
      if (saved?.exportId && saved.sourceVideo && saved.renderedAt && typeof saved.durationSeconds === "number" && !candidates.some(c => c.videoId === manifest.videoId && c.exportId === saved.exportId))
        candidates.push({ videoId: manifest.videoId, filename: saved.sourceVideo, durationSeconds: saved.durationSeconds, renderedAt: saved.renderedAt, captionOptions: [], uploadedAt: null, exportId: saved.exportId });
    }
    const captionOptions = new Set<string>();
    const captionsFile = (await readJson(
      join(ANALYSIS_DIR, `${manifest.videoId}.captions.json`)
    )) as { captions?: { text?: unknown }[] } | null;
    for (const c of captionsFile?.captions ?? []) {
      if (typeof c?.text === "string") captionOptions.add(c.text);
    }

    candidates.push({
      videoId: manifest.videoId,
      filename: manifest.sourceVideo,
      durationSeconds: manifest.durationSeconds,
      renderedAt: manifest.renderedAt,
      captionOptions: [...captionOptions],
      uploadedAt: null,
      exportId: manifest.exportId,
    });
  }
  return candidates;
}

export async function POST(request: NextRequest) {
  let body: z.infer<typeof BodyZ>;
  try {
    body = BodyZ.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const candidates = await loadCandidates();
  const links = await readPublishedLinks();
  const matches = matchPublished(body.videos as PublishedFacts[], candidates).filter(m => !(m.publishedId in links));
  for (const video of body.videos) {
    const link = links[video.id];
    if (link?.videoId && link.filename) matches.push({ publishedId: video.id, videoId: link.videoId, filename: link.filename, exportId: link.exportId, score: 1, confirmed: true });
  }

  // Display names make the button tooltip human-readable
  const names = ((await readJson(join(DOWNLOADS_DIR, ".names.json"))) ??
    {}) as Record<string, unknown>;
  const decorated = matches.map((m) => ({
    ...m,
    displayName:
      typeof names[m.filename] === "string"
        ? (names[m.filename] as string)
        : null,
  }));

  return NextResponse.json({ matches: decorated, candidates: candidates.filter((c, i) => candidates.findIndex(other => other.videoId === c.videoId && other.exportId === c.exportId) === i).map(c => ({ videoId: c.videoId, filename: c.filename, exportId: c.exportId, renderedAt: c.renderedAt })) });
}

export async function PATCH(request: NextRequest) {
  try {
    const input = z.object({ publishedId: z.string().min(1).max(100), videoId: z.string().nullable(), exportId: z.string().optional() }).parse(await request.json());
    if (!input.videoId) { await savePublishedLink(input.publishedId, { videoId: null }); return NextResponse.json({ saved: true }); }
    if (!isValidVideoId(input.videoId)) throw new Error("Invalid project ID");
    const file = input.exportId ? exportPaths(input.videoId, input.exportId).manifest : join(RENDERS_DIR, `${input.videoId}.render.json`);
    const manifest = await readJson(file) as { sourceVideo?: string; exportId?: string } | null;
    if (!manifest?.sourceVideo || !(await resolveProjectFile(manifest.sourceVideo))) throw new Error("Export not found");
    await savePublishedLink(input.publishedId, { videoId: input.videoId, filename: manifest.sourceVideo, exportId: input.exportId ?? manifest.exportId });
    return NextResponse.json({ saved: true });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save link" }, { status: 400 }); }
}
