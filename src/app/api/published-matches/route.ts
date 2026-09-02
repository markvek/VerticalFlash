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
    return [];
  }

  const store = await readPublishStore();
  // Latest upload per videoId — records are append-only, so last wins
  const latestUpload = new Map<string, string>();
  const storedCaptions = new Map<string, string[]>();
  for (const record of store.publishes) {
    latestUpload.set(record.videoId, record.uploadedAt);
    if (record.captionOptions.length)
      storedCaptions.set(record.videoId, record.captionOptions);
  }

  const candidates: RenderCandidate[] = [];
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
      await fs.access(join(DOWNLOADS_DIR, manifest.sourceVideo));
    } catch {
      continue;
    }

    const captionOptions = new Set<string>(
      storedCaptions.get(manifest.videoId) ?? []
    );
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
      uploadedAt: latestUpload.get(manifest.videoId) ?? null,
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
  const matches = matchPublished(body.videos as PublishedFacts[], candidates);

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

  return NextResponse.json({ matches: decorated });
}
