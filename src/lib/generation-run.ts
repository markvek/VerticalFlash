import { NextResponse } from "next/server";
import { ffmpegErrorResponse } from "./ffmpeg";
import { GEMINI_VIDEO_MODEL } from "./gemini";
import { classifyGeminiError } from "./library-analyze";
import {
  loadGenerations,
  saveGenerations,
  getOrCreateShot,
} from "./generation-store";
import type { ShotGenerations } from "./generation-schema";
import {
  runGeneration,
  type RunGenerationResult,
} from "./generate-clip";

// One generation per shot at a time, shared by the generate and extend
// routes so they can't race each other on the same shot
const inFlight = new Set<string>();

const ERROR_STATUS: Record<string, number> = {
  rate_limit: 429,
  daily_quota: 429,
  unavailable: 503,
  fatal: 500,
};

export function generationErrorResponse(error: unknown): NextResponse {
  const missing = ffmpegErrorResponse(error);
  if (missing) return missing;
  const { kind, retryAfterMs } = classifyGeminiError(error);
  const message = error instanceof Error ? error.message : "Generation failed";
  // Omni safety blocks surface as failed interactions mentioning safety —
  // tell the user the fix is a prompt edit, not a retry
  const friendly = /safety|blocked|prohibited/i.test(message)
    ? `${message} — blocked by safety filters; edit the prompt and try again`
    : message;
  return NextResponse.json(
    { error: friendly, kind, retryAfterMs },
    { status: ERROR_STATUS[kind] ?? 500 }
  );
}

export interface AttemptSpec {
  videoId: string;
  shotIndex: number;
  kind: "generate" | "extend";
  prompt: string;
  sourceClip: string | null;
  referenceFiles: string[];
  targetSeconds: number;
  // Runs the actual generation once the attempt slot is reserved
  run: (attempt: number) => Promise<RunGenerationResult>;
}

// Reserve the shot, persist the in-flight marker, run, and record the
// attempt (success or failure) in the sidecar. Throws a NextResponse-ready
// error object only for the busy case.
export async function executeGenerationAttempt(
  spec: AttemptSpec
): Promise<{ generations: ShotGenerations } | { busy: true }> {
  const key = `${spec.videoId}:${spec.shotIndex}`;
  if (inFlight.has(key)) {
    return { busy: true };
  }
  inFlight.add(key);
  try {
    let generations = await loadGenerations(spec.videoId);
    let shot = getOrCreateShot(generations, spec.shotIndex);
    if (shot.status === "generating") {
      return { busy: true };
    }
    const attemptNumber = shot.attempts.length + 1;
    shot.status = "generating";
    shot.startedAt = new Date().toISOString();
    await saveGenerations(generations);

    let result: RunGenerationResult | null = null;
    let failure: unknown = null;
    try {
      result = await spec.run(attemptNumber);
    } catch (error) {
      failure = error;
    }

    // Re-load in case the user edited the prompt while generating
    generations = await loadGenerations(spec.videoId);
    shot = getOrCreateShot(generations, spec.shotIndex);
    shot.attempts.push({
      attempt: attemptNumber,
      kind: spec.kind,
      prompt: spec.prompt,
      source_clip: spec.sourceClip,
      reference_files: spec.referenceFiles,
      file: result?.file ?? null,
      duration: result?.duration ?? null,
      interaction_id: result?.interactionId ?? null,
      status: result ? "ready" : "failed",
      error:
        failure == null
          ? null
          : failure instanceof Error
            ? failure.message
            : String(failure),
      ...(result?.usage ? { usage: result.usage } : {}),
      video_seconds: result?.videoSeconds ?? null,
      model: GEMINI_VIDEO_MODEL,
      createdAt: new Date().toISOString(),
    });
    shot.status = result ? "ready" : "failed";
    shot.startedAt = null;
    await saveGenerations(generations);

    if (failure != null) throw failure;
    return { generations };
  } finally {
    inFlight.delete(key);
  }
}
