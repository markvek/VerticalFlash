import { beginActivity, finishActivity } from "./workflow-activity";
import { NextResponse } from "next/server";
import { ffmpegErrorResponse } from "./ffmpeg";
import { GEMINI_VIDEO_MODEL } from "./gemini";
import { classifyGeminiError } from "./library-analyze";
import {
  mutateGenerations,
  getOrCreateShot,
} from "./generation-store";
import type { ShotGenerations } from "./generation-schema";
import {
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
    let attemptNumber = 0;
    await mutateGenerations(spec.videoId, generations => {
      const shot = getOrCreateShot(generations, spec.shotIndex);
      if (shot.status === "generating") return;
      attemptNumber = shot.attempts.length + 1;
      shot.status = "generating"; shot.startedAt = new Date().toISOString();
    });

    if (!attemptNumber) return { busy: true };
    const activity = await beginActivity(spec.videoId, `${spec.kind === "generate" ? "Generate" : "Extend"} clip ${spec.shotIndex + 1}`);
    let result: RunGenerationResult | null = null;
    let failure: unknown = null;
    try {
      result = await spec.run(attemptNumber);
    } catch (error) {
      failure = error;
    }

    // Re-load in case the user edited the prompt while generating
    const generations = await mutateGenerations(spec.videoId, current => {
    const shot = getOrCreateShot(current, spec.shotIndex);
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
    });

    if (activity) await finishActivity(activity, failure == null ? null : failure instanceof Error ? failure.message : String(failure));
    if (failure != null) throw failure;
    return { generations };
  } finally {
    inFlight.delete(key);
  }
}
