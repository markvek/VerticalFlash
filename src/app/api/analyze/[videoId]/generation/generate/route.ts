import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import type { GoogleGenAI } from "@google/genai";
import { getGeminiClient } from "@/lib/gemini";
import { AnalysisZ, type Analysis } from "@/lib/analysis-schema";
import { loadLibrary } from "@/lib/library-analyze";
import { loadGenerations } from "@/lib/generation-store";
import { shotDurationSeconds } from "@/lib/generation-prompts";
import {
  pickReferenceClips,
  prepareReferenceMedia,
  runGeneration,
} from "@/lib/generate-clip";
import {
  executeGenerationAttempt,
  generationErrorResponse,
} from "@/lib/generation-run";
import { ANALYSIS_DIR } from "@/lib/paths";


// Video generation takes minutes (upload refs, generate, download 1080p)
export const maxDuration = 600;

async function loadAnalysis(videoId: string): Promise<Analysis | null> {
  try {
    const raw = await fs.readFile(join(ANALYSIS_DIR, `${videoId}.json`), "utf8");
    return AnalysisZ.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Generate an AI clip for one shot from its stored prompt
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let submittedPrompt: string | undefined;
  let shotIndex: number;
  let useReferences = true;
  try {
    const body = await request.json();
    shotIndex = body.shot_index;
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 4000) {
        return NextResponse.json({ error: "prompt must contain 1–4000 characters" }, { status: 400 });
      }
      submittedPrompt = body.prompt.trim();
    }
    if (body.use_references === false) useReferences = false;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (typeof shotIndex !== "number" || !Number.isInteger(shotIndex)) {
    return NextResponse.json(
      { error: "shot_index is required" },
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

  const generations = await loadGenerations(videoId);
  const prompt = submittedPrompt ?? generations.shots[String(shotIndex)]?.prompt?.trim();
  if (!prompt) {
    return NextResponse.json(
      { error: "No generation prompt for this shot — draft one first" },
      { status: 400 }
    );
  }

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

  // Character references: real library clips that show the product
  let referenceFiles: string[] = [];
  let referencePaths: string[] = [];
  if (useReferences) {
    const library = await loadLibrary();
    referenceFiles = pickReferenceClips(library, shot);
    if (!dryRun && referenceFiles.length) {
      referencePaths = await prepareReferenceMedia(referenceFiles);
    }
  }

  try {
    const outcome = await executeGenerationAttempt({
      videoId,
      shotIndex,
      kind: "generate",
      prompt,
      sourceClip: null,
      referenceFiles,
      targetSeconds: shotDurationSeconds(shot),
      run: (attempt) =>
        runGeneration({
          ai: ai!,
          videoId,
          shotIndex,
          attempt,
          kind: "generate",
          prompt,
          referencePaths,
          targetSeconds: shotDurationSeconds(shot),
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
    console.error(`clip generation failed (shot ${shotIndex}):`, error);
    return generationErrorResponse(error);
  }
}
