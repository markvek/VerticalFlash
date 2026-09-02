import { NextRequest, NextResponse } from "next/server";
import { execFileAsync } from "@/lib/ffmpeg";
import { promises as fs } from "fs";
import { join, basename } from "path";
import type { GoogleGenAI } from "@google/genai";
import { getGeminiClient } from "@/lib/gemini";
import { AnalysisZ, type Analysis } from "@/lib/analysis-schema";
import { loadLibrary } from "@/lib/library-analyze";
import {
  ShotRecommendationsZ,
} from "@/lib/recommendation-schema";
import {
  defaultExtendPrompt,
  shotDurationSeconds,
} from "@/lib/generation-prompts";
import { generatedClipDir } from "@/lib/generation-schema";
import {
  EXTEND_INPUT_SECONDS,
  probeDurationSeconds,
  runGeneration,
} from "@/lib/generate-clip";
import {
  executeGenerationAttempt,
  generationErrorResponse,
} from "@/lib/generation-run";
import { ANALYSIS_DIR, LIBRARY_DIR } from "@/lib/paths";

export const maxDuration = 600;

async function loadAnalysis(videoId: string): Promise<Analysis | null> {
  try {
    const raw = await fs.readFile(join(ANALYSIS_DIR, `${videoId}.json`), "utf8");
    return AnalysisZ.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

// The user's trim window start for this clip on this shot, if one is stored
async function storedTrimStart(
  videoId: string,
  shotIndex: number,
  filename: string
): Promise<number | null> {
  try {
    const raw = await fs.readFile(
      join(ANALYSIS_DIR, `${videoId}.recommendations.json`),
      "utf8"
    );
    const stored = ShotRecommendationsZ.parse(JSON.parse(raw));
    const shot = stored.shots.find((s) => s.shot_index === shotIndex);
    const rec = shot?.recommendations.find((r) => r.filename === filename);
    return rec?.trim_start ?? null;
  } catch {
    return null;
  }
}

// Extend a too-short library clip: Omni continues its final seconds so the
// result covers the shot without freeze/loop/black fills
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let shotIndex: number;
  let filename: string;
  let customPrompt: string | null = null;
  try {
    const body = await request.json();
    shotIndex = body.shot_index;
    filename = body.filename;
    if (typeof body.prompt === "string" && body.prompt.trim()) {
      customPrompt = body.prompt.trim();
    }
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (typeof shotIndex !== "number" || !Number.isInteger(shotIndex)) {
    return NextResponse.json(
      { error: "shot_index is required" },
      { status: 400 }
    );
  }
  if (typeof filename !== "string" || basename(filename) !== filename) {
    return NextResponse.json({ error: "invalid filename" }, { status: 400 });
  }

  const sourcePath = join(LIBRARY_DIR, filename);
  try {
    await fs.access(sourcePath);
  } catch {
    return NextResponse.json(
      { error: "filename is not in the clip library" },
      { status: 400 }
    );
  }

  const analysis = await loadAnalysis(videoId);
  const shot = analysis?.shots.find((s) => s.index === shotIndex);
  if (!analysis || !shot) {
    return NextResponse.json(
      { error: "Unknown shot — run the shot analysis first" },
      { status: 404 }
    );
  }

  const clipDuration = await probeDurationSeconds(sourcePath);
  if (clipDuration == null) {
    return NextResponse.json(
      { error: "Could not read the clip's duration" },
      { status: 500 }
    );
  }

  const shotDuration = shotDurationSeconds(shot);

  const dryRun = process.env.GENAI_VIDEO_DRY_RUN === "1";
  let ai: GoogleGenAI | null = null;
  if (!dryRun) {
    try {
      ai = getGeminiClient();
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Gemini not configured" },
        { status: 500 }
      );
    }
  }

  // Omni takes at most the last 10 seconds as extension input; honor the
  // user's trim start when it lies inside that window
  const trimStart = await storedTrimStart(videoId, shotIndex, filename);
  const windowStart = Math.max(
    trimStart ?? 0,
    Math.max(0, clipDuration - EXTEND_INPUT_SECONDS)
  );
  const windowLength = Math.max(0.5, clipDuration - windowStart);
  const secondsNeeded = Math.max(1, shotDuration - windowLength);

  const library = await loadLibrary();
  const sourceDescription =
    library.videos.find((v) => v.filename === filename)?.analysis
      ?.description ?? null;
  const prompt =
    customPrompt ?? defaultExtendPrompt(shot, sourceDescription, secondsNeeded);

  // Cut the input window to a scratch file (audio stripped — generated
  // clips are used video-only)
  const workDir = join(generatedClipDir(videoId), ".work");
  await fs.mkdir(workDir, { recursive: true });
  const scratchPath = join(workDir, `extend_s${shotIndex}_${Date.now()}.mp4`);

  try {
    if (!dryRun) {
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss",
        windowStart.toFixed(2),
        "-i",
        sourcePath,
        "-t",
        windowLength.toFixed(2),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        scratchPath,
      ]);
    }

    const outcome = await executeGenerationAttempt({
      videoId,
      shotIndex,
      kind: "extend",
      prompt,
      sourceClip: filename,
      referenceFiles: [],
      targetSeconds: shotDuration,
      run: (attempt) =>
        runGeneration({
          ai: ai!,
          videoId,
          shotIndex,
          attempt,
          kind: "extend",
          prompt,
          sourceClipPath: scratchPath,
          targetSeconds: shotDuration,
        }),
    });
    if ("busy" in outcome) {
      return NextResponse.json(
        { error: "A generation is already running for this shot" },
        { status: 409 }
      );
    }
    return NextResponse.json(outcome.generations);
  } catch (error) {
    console.error(`clip extension failed (shot ${shotIndex}):`, error);
    return generationErrorResponse(error);
  } finally {
    await fs.rm(scratchPath, { force: true }).catch(() => {});
  }
}
