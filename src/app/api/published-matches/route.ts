import { readPublishedLinks, savePublishedLink } from "@/lib/published-links";
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
import { findDownloadFile, resolveProjectFile } from "@/lib/download-files";


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
    .max(200),
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
    entries = [];
  }

  const store = await readPublishStore();
  const candidates: RenderCandidate[] = [];
  for (const record of store.publishes) {
    if (!isValidVideoId(record.videoId) || record.status === "FAILED" || record.durationSeconds == null || !record.renderedAt) continue;
    const source = await findDownloadFile(record.videoId);
    if (!source) continue;
    candidates.push({ videoId: record.videoId, filename: source.filename, exportId: record.exportId,
      publishId: record.publishId, durationSeconds: record.durationSeconds, renderedAt: record.renderedAt,
      captionOptions: record.captionOptions, uploadedAt: record.uploadedAt });
  }
  const uploadedProjects = new Set(candidates.map(candidate => candidate.videoId));
  for (const entry of entries) {
    if (!entry.endsWith(".render.json")) continue;
    const manifest = (await readJson(join(RENDERS_DIR, entry))) as {
      videoId?: unknown;
      sourceVideo?: unknown;
      durationSeconds?: unknown;
      renderedAt?: unknown;
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

    const captionOptions = new Set<string>();
    const captionsFile = (await readJson(
      join(ANALYSIS_DIR, `${manifest.videoId}.captions.json`)
    )) as { captions?: { text?: unknown }[] } | null;
    for (const c of captionsFile?.captions ?? []) {
      if (typeof c?.text === "string") captionOptions.add(c.text);
    }

    if (uploadedProjects.has(manifest.videoId)) continue;
    candidates.push({
      videoId: manifest.videoId,
      filename: manifest.sourceVideo,
      durationSeconds: manifest.durationSeconds,
      renderedAt: manifest.renderedAt,
      captionOptions: [...captionOptions],
      uploadedAt: null,
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
  const matches = matchPublished(body.videos.filter(video => !(video.id in links)) as PublishedFacts[], candidates);
  for (const video of body.videos) {
    const candidate = candidates.find(candidate => candidate.publishId === links[video.id]);
    if (candidate) matches.push({ publishedId: video.id, videoId: candidate.videoId, filename: candidate.filename,
      publishId: candidate.publishId, exportId: candidate.exportId, score: 1 });
  }

  // Display names make the button tooltip human-readable
  const names = ((await readJson(join(DOWNLOADS_DIR, ".names.json"))) ??
    {}) as Record<string, unknown>;
  const decorated = matches.map((m) => ({
    ...m,
    confirmed: m.publishedId in links,
    displayName:
      typeof names[m.filename] === "string"
        ? (names[m.filename] as string)
        : null,
  }));

  return NextResponse.json({ matches: decorated });
}

// Lists immutable upload choices so clients can confirm or correct attribution.
export async function GET() {
  return NextResponse.json({ candidates: await loadCandidates(), links: await readPublishedLinks() });
}

export async function PATCH(request: NextRequest) {
  let body: { publishedId: string; publishId: string | null };
  try { body = z.object({ publishedId: z.string().min(1).max(200), publishId: z.string().min(1).nullable() }).parse(await request.json()); }
  catch { return NextResponse.json({ error: "Provide a publishedId and an upload publishId, or null to remove attribution" }, { status: 400 }); }
  if (body.publishId !== null && !(await loadCandidates()).some(candidate => candidate.publishId === body.publishId)) {
    return NextResponse.json({ error: "Upload version not found" }, { status: 404 });
  }
  await savePublishedLink(body.publishedId, body.publishId);
  return NextResponse.json({ ...body, confirmed: true });
}
