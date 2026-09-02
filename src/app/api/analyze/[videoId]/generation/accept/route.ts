import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { AnalysisZ, type Analysis } from "@/lib/analysis-schema";
import {
  ShotRecommendationsZ,
  type Recommendation,
  type ShotRecommendations,
} from "@/lib/recommendation-schema";
import { generatedClipDir } from "@/lib/generation-schema";
import {
  loadGenerations,
  saveGenerations,
} from "@/lib/generation-store";
import { shotDurationSeconds } from "@/lib/generation-prompts";
import { ANALYSIS_DIR } from "@/lib/paths";


function recommendationsPath(videoId: string): string {
  return join(ANALYSIS_DIR, `${videoId}.recommendations.json`);
}

async function loadAnalysis(videoId: string): Promise<Analysis | null> {
  try {
    const raw = await fs.readFile(join(ANALYSIS_DIR, `${videoId}.json`), "utf8");
    return AnalysisZ.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Accept one generated attempt as the shot's clip: it becomes a first-class
// source:"generated" recommendation and the shot's selection, so the
// timeline, render breakdown, and planner all pick it up through the
// existing selection machinery.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let shotIndex: number;
  let attemptNumber: number;
  try {
    const body = await request.json();
    shotIndex = body.shot_index;
    attemptNumber = body.attempt;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (
    typeof shotIndex !== "number" ||
    !Number.isInteger(shotIndex) ||
    typeof attemptNumber !== "number" ||
    !Number.isInteger(attemptNumber)
  ) {
    return NextResponse.json(
      { error: "shot_index and attempt are required" },
      { status: 400 }
    );
  }

  const analysis = await loadAnalysis(videoId);
  const analysisShot = analysis?.shots.find((s) => s.index === shotIndex);
  if (!analysis || !analysisShot) {
    return NextResponse.json(
      { error: "Unknown shot — run the shot analysis first" },
      { status: 404 }
    );
  }

  const generations = await loadGenerations(videoId);
  const genShot = generations.shots[String(shotIndex)];
  const attempt = genShot?.attempts.find((a) => a.attempt === attemptNumber);
  if (!genShot || !attempt || attempt.status !== "ready" || !attempt.file) {
    return NextResponse.json(
      { error: "No ready attempt with that number for this shot" },
      { status: 404 }
    );
  }
  try {
    await fs.access(join(generatedClipDir(videoId), attempt.file));
  } catch {
    return NextResponse.json(
      { error: "The generated clip file is missing on disk" },
      { status: 404 }
    );
  }

  // Load recommendations; a video generated entirely without library
  // matches still needs the file, so synthesize an empty one
  let recs: ShotRecommendations;
  try {
    const raw = await fs.readFile(recommendationsPath(videoId), "utf8");
    recs = ShotRecommendationsZ.parse(JSON.parse(raw));
  } catch {
    recs = {
      videoId,
      generatedAt: new Date().toISOString(),
      model: "none",
      clipsConsidered: 0,
      shots: analysis.shots.map((s) => ({
        shot_index: s.index,
        recommendations: [],
      })),
    };
  }

  let recShot = recs.shots.find((s) => s.shot_index === shotIndex);
  if (!recShot) {
    recShot = { shot_index: shotIndex, recommendations: [] };
    recs.shots.push(recShot);
    recs.shots.sort((a, b) => a.shot_index - b.shot_index);
  }

  const shotDuration = shotDurationSeconds(analysisShot);
  const duration = attempt.duration;
  const generatedRec: Recommendation = {
    filename: attempt.file,
    duration,
    confidence: "strong",
    reason:
      attempt.kind === "extend"
        ? `AI-extended from ${attempt.source_clip ?? "a library clip"}`
        : "AI-generated for this shot",
    source: "generated",
    tag_overlap: [],
    score: 3,
    // Explicit trims: the clip was made for this shot, play it from the top
    trim_start: 0,
    trim_end:
      duration != null
        ? Math.round(Math.min(duration, shotDuration) * 10) / 10
        : shotDuration,
    moment_note: attempt.kind === "extend" ? "extended clip" : "generated clip",
  };

  // At most one generated rec per shot — accepting a different attempt
  // replaces the previous one
  recShot.recommendations = recShot.recommendations.filter(
    (r) => r.source !== "generated"
  );
  recShot.recommendations.push(generatedRec);
  recShot.selected_filename = attempt.file;

  genShot.accepted_file = attempt.file;

  const path = recommendationsPath(videoId);
  const tmp = `${path}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify(ShotRecommendationsZ.parse(recs), null, 2)
  );
  await fs.rename(tmp, path);
  await saveGenerations(generations);

  return NextResponse.json({ generation: generations, recommendations: recs });
}
