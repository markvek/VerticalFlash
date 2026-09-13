import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { z } from "zod";
import { isValidVideoId } from "@/lib/video-id";
import { readStoryboards, readSavedStoryboard } from "@/lib/storyboard-store";
import { readStoryboardSegments } from "@/lib/storyboard-footage";
import { readViralityReview, reviewStoryboard } from "@/lib/storyboard-virality";
import { findDownloadFile } from "@/lib/download-files";
import { readProjectMeta } from "@/lib/project-meta";
import { getGeminiClient } from "@/lib/gemini";
import { nativeModel } from "@/lib/models/native";
import { analysisPath, sidecarPath } from "@/lib/paths";
import { ViralityReviewZ } from "@/lib/virality-schema";

export const maxDuration = 300;
type Context = { params: Promise<{ videoId: string }> };

export async function GET(_request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) return NextResponse.json({ error: "Invalid videoId" }, { status: 400 });
  try {
    const file = await findDownloadFile(videoId);
    const meta = file ? await readProjectMeta(file.path) : null;
    if (meta?.kind === "cutdown") {
      let review = null;
      try { review = ViralityReviewZ.nullable().parse(JSON.parse(await fs.readFile(sidecarPath(videoId, "virality"), "utf8")).review); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let timelineChanged = false;
      try { timelineChanged = !!JSON.parse(await fs.readFile(analysisPath(videoId), "utf8")).shotsEditedAt; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return NextResponse.json({ snapshot: true, timelineChanged, items: meta.storyboardSnapshot ? [{ storyboard: meta.storyboardSnapshot, review }] : [] });
    }
    if (meta?.kind !== "master") return NextResponse.json({ snapshot: false, items: [] });
    const doc = await readStoryboards(videoId);
    const items = await Promise.all((doc?.storyboards ?? []).map(async storyboard => {
      const record = (await readSavedStoryboard(videoId, storyboard.id))!;
      return { storyboard, review: await readViralityReview(videoId, storyboard, record.request.brief) };
    }));
    return NextResponse.json({ snapshot: false, items });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load review" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) return NextResponse.json({ error: "Invalid videoId" }, { status: 400 });
  const parsed = z.object({ storyboard_id: z.string().regex(/^[\w-]+$/) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid storyboard_id is required" }, { status: 400 });
  try {
    const file = await findDownloadFile(videoId);
    if (!file || (await readProjectMeta(file.path))?.kind !== "master") return NextResponse.json({ error: "Storyboard project not found" }, { status: 404 });
    const doc = await readSavedStoryboard(videoId, parsed.data.storyboard_id);
    const segments = await readStoryboardSegments(videoId);
    if (!doc || !segments) return NextResponse.json({ error: "Storyboard or source transcript not found" }, { status: 404 });
    const review = await reviewStoryboard(doc, doc.storyboards[0], segments, getGeminiClient(nativeModel(doc.request.model)));
    return NextResponse.json({ review });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Review failed" }, { status: 500 });
  }
}
