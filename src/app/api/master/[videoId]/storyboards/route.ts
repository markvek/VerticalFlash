import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { GoogleGenAI } from "@google/genai";
import { isValidVideoId } from "@/lib/video-id";
import { classifyGeminiError, getGeminiClient } from "@/lib/gemini";
import { storyboardDryRun } from "@/lib/master-analyze";
import { readStoryboardSegments, resolveStoryboardBeat } from "@/lib/storyboard-footage";
import {
  generateStoryboards,
  lengthsFor,
  normalizeEditableStoryboard,
  readStoryboards,
  writeStoryboards,
} from "@/lib/storyboard-plan";
import { BeatZ, StoryboardRequestZ } from "@/lib/segments-schema";
import { readProjectMeta } from "@/lib/project-meta";
import { findDownloadFile } from "@/lib/download-files";
import { probeDuration } from "@/lib/master-assemble";
import { loadCatalogSummary } from "@/lib/shot-plan";
import { updateSavedStoryboard } from "@/lib/storyboard-store";
import { resolveWordBeat } from "@/lib/word-range";

export const maxDuration = 300;

const inFlight = new Set<string>();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  const doc = await readStoryboards(videoId);
  if (!doc) {
    return NextResponse.json({ error: "No storyboards yet" }, { status: 404 });
  }
  return NextResponse.json(doc);
}

// Generate additional, independently saved ideas for a master.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = StoryboardRequestZ.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues
          .map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
          .join("; "),
      },
      { status: 400 }
    );
  }
  const req = parsed.data;
  try {
    lengthsFor(req);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid lengths" },
      { status: 400 }
    );
  }

  const file = await findDownloadFile(videoId);
  if (!file) {
    return NextResponse.json({ error: "Master not found" }, { status: 404 });
  }
  const meta = await readProjectMeta(file.path);
  if (meta?.kind !== "master") {
    return NextResponse.json(
      { error: "Storyboards can only be generated for a master project" },
      { status: 400 }
    );
  }
  const segments = await readStoryboardSegments(videoId);
  if (!segments) {
    return NextResponse.json(
      { error: "Analyze the master first — no transcript segments found" },
      { status: 404 }
    );
  }

  let ai: GoogleGenAI | null = null;
  try {
    ai = getGeminiClient();
  } catch (error) {
    if (!storyboardDryRun()) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Gemini not configured" },
        { status: 500 }
      );
    }
  }

  if (inFlight.has(videoId)) {
    return NextResponse.json(
      { error: "Storyboards for this master are already being generated" },
      { status: 409 }
    );
  }
  inFlight.add(videoId);
  try {
    const duration = Math.max((await probeDuration(file.path)) ?? 0, ...segments.segments.map((segment) => segment.end_time));
    // B-roll candidates: the analyzed library minus the master's own clips
    let catalog = null;
    if (req.allow_broll) {
      const own = new Set(meta.sourceClips.map((c) => c.filename));
      const all = await loadCatalogSummary();
      catalog = all.filter((c) => !own.has(c.filename));
    }
    const doc = await generateStoryboards(ai, segments, req, duration, catalog);
    return NextResponse.json(await writeStoryboards(doc));
  } catch (error) {
    console.error("storyboard generation failed:", error);
    const { kind } = classifyGeminiError(error);
    const status =
      kind === "rate_limit" || kind === "daily_quota"
        ? 429
        : kind === "unavailable"
          ? 503
          : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Storyboard generation failed" },
      { status }
    );
  } finally {
    inFlight.delete(videoId);
  }
}

const StoryboardEditZ = z.object({
  storyboard_id: z.string().min(1),
  beats: z.array(BeatZ).min(1),
});

// Persist light storyboard edits from the UI: reordered beats and transcript
// segments added into the chosen idea. The accepted short is cut from this
// edited version.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let parsed: z.infer<typeof StoryboardEditZ>;
  try {
    parsed = StoryboardEditZ.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues
                .map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
                .join("; ")
            : "Invalid request",
      },
      { status: 400 }
    );
  }

  const file = await findDownloadFile(videoId);
  if (!file) {
    return NextResponse.json({ error: "Master not found" }, { status: 404 });
  }
  const meta = await readProjectMeta(file.path);
  if (meta?.kind !== "master") {
    return NextResponse.json(
      { error: "Storyboards can only be edited for a master project" },
      { status: 400 }
    );
  }

  const doc = await readStoryboards(videoId);
  if (!doc) {
    return NextResponse.json({ error: "No storyboards yet" }, { status: 404 });
  }

  const index = doc.storyboards.findIndex((s) => s.id === parsed.storyboard_id);
  if (index === -1) {
    return NextResponse.json({ error: "Unknown storyboard_id" }, { status: 404 });
  }

  // For the master's own transcript the word range is the source of truth:
  // a trimmed beat arrives with a new start_word/end_word and gets its cut
  // times and text resolved here (attached footage has no word timing)
  const segments = await readStoryboardSegments(videoId);
  const masterDuration = (await probeDuration(file.path)) ?? 0;
  const beats = parsed.beats.map((beat) => {
    if (beat.source || !segments?.words.length) return beat;
    const resolved = resolveWordBeat(beat, segments.words, masterDuration);
    return resolved ? { ...beat, ...resolved } : beat;
  });

  try {
    for (const beat of beats) await resolveStoryboardBeat(videoId, beat, file.path);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid footage" }, { status: 400 });
  }
  const updated = await updateSavedStoryboard(videoId, parsed.storyboard_id, (saved) => {
    saved.storyboards[0] = normalizeEditableStoryboard({
      ...saved.storyboards[0],
      beats,
    });
  });
  return NextResponse.json({
    storyboard: updated?.storyboards.find((idea) => idea.id === parsed.storyboard_id),
    storyboards: updated,
  });
}
