import { NextRequest, NextResponse } from "next/server";
import { ensureFfmpeg, ffmpegErrorResponse } from "@/lib/ffmpeg";
import { promises as fs } from "fs";
import { basename, join } from "path";
import { AnalysisZ, type Analysis } from "@/lib/analysis-schema";
import {
  ShotRecommendationsZ,
  type ShotRecommendations,
} from "@/lib/recommendation-schema";
import { loadLibrary } from "@/lib/library-analyze";
import { renderRemake, renderManifestPath } from "@/lib/render-remake";
import { EditNotesZ, editNotesPath } from "@/lib/edit-notes";
import { isValidMusicFilename } from "@/lib/music-schema";
import {
  TextOverlaysZ,
  textOverlaysPath,
  type TextOverlays,
} from "@/lib/text-overlays-schema";
import { ANALYSIS_DIR } from "@/lib/paths";
import { findDownloadFile } from "@/lib/download-files";
import { readProjectMeta } from "@/lib/project-meta";
import { cutdownSourceShots, withSourceRanges } from "@/lib/cutdown-build";

// Encoding ~15 segments plus any on-demand Gemini trim calls takes a while
export const maxDuration = 300;

// One render per video at a time (single-process dev server, no job queue)
const inFlight = new Set<string>();

async function findVideoFile(videoId: string): Promise<string | null> {
  return (await findDownloadFile(videoId))?.path ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  try {
    const raw = await fs.readFile(renderManifestPath(videoId), "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json(
      { error: "No render found for this video" },
      { status: 404 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  // Optional body: { audio: "music"|"original"|"none", music_filename,
  // burn_text } — older clients send include_original_audio instead of
  // audio. Everything defaults to off; the UI sends its values explicitly.
  let audio: "music" | "original" | "none" = "none";
  let musicFilename: string | null = null;
  let burnText = false;
  try {
    const body = await request.json();
    if (body?.audio === "music" || body?.audio === "original" || body?.audio === "none") {
      audio = body.audio;
    } else if (body?.include_original_audio === true) {
      audio = "original";
    }
    if (typeof body?.music_filename === "string" && body.music_filename) {
      musicFilename = body.music_filename;
    }
    burnText = body?.burn_text === true;
  } catch {
    // no body sent
  }
  if (musicFilename && !isValidMusicFilename(musicFilename)) {
    return NextResponse.json({ error: "invalid music_filename" }, { status: 400 });
  }

  if (inFlight.has(videoId)) {
    return NextResponse.json(
      { error: "A render for this video is already running" },
      { status: 409 }
    );
  }
  inFlight.add(videoId);

  try {
    try {
      await ensureFfmpeg();
    } catch (error) {
      return ffmpegErrorResponse(error)!;
    }

    let analysis: Analysis;
    try {
      const raw = await fs.readFile(
        join(ANALYSIS_DIR, `${videoId}.json`),
        "utf8"
      );
      analysis = AnalysisZ.parse(JSON.parse(raw));
    } catch {
      return NextResponse.json(
        { error: "Run the Gemini shot analysis first — no analysis found" },
        { status: 404 }
      );
    }

    let recs: ShotRecommendations;
    try {
      const raw = await fs.readFile(
        join(ANALYSIS_DIR, `${videoId}.recommendations.json`),
        "utf8"
      );
      recs = ShotRecommendationsZ.parse(JSON.parse(raw));
    } catch {
      return NextResponse.json(
        { error: "Match library clips first — no recommendations found" },
        { status: 404 }
      );
    }

    const videoPath = await findVideoFile(videoId);
    if (!videoPath) {
      return NextResponse.json(
        { error: `No downloaded mp4 found for video ${videoId}` },
        { status: 404 }
      );
    }

    const library = await loadLibrary();

    // A cutdown renders its source shots from the footage ranges (master
    // or attached clips), so timeline edits need no re-cut of the short
    const meta = await readProjectMeta(videoPath);
    let sourceShots: Awaited<ReturnType<typeof cutdownSourceShots>> | null = null;
    if (meta?.kind === "cutdown") {
      analysis = withSourceRanges(analysis, meta);
      sourceShots = await cutdownSourceShots(meta);
    }

    let editNotes: Record<string, string> = {};
    try {
      const raw = await fs.readFile(editNotesPath(videoId), "utf8");
      editNotes = EditNotesZ.parse(JSON.parse(raw)).notes;
    } catch {
      // no notes saved yet
    }

    let textOverlays: TextOverlays | null = null;
    try {
      const raw = await fs.readFile(textOverlaysPath(videoId), "utf8");
      textOverlays = TextOverlaysZ.parse(JSON.parse(raw));
    } catch {
      // none saved — the burn falls back to the analysis's detected text
    }

    const manifest = await renderRemake({
      videoId,
      analysis,
      recs,
      sourceVideo: basename(videoPath),
      library,
      editNotes,
      audio,
      musicFilename,
      burnText,
      textOverlays,
      sourceShots,
    });

    return NextResponse.json(manifest);
  } catch (error) {
    console.error("render failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Render failed" },
      { status: 500 }
    );
  } finally {
    inFlight.delete(videoId);
  }
}
