import { projectModel, saveProjectModel } from "@/lib/models/native";
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import type { GoogleGenAI } from "@google/genai";
import { getGeminiClient, getGeminiModel } from "@/lib/gemini";
import { AnalysisZ, type Analysis } from "@/lib/analysis-schema";
import {
  ShotRecommendationsZ,
  type ShotRecommendations,
} from "@/lib/recommendation-schema";
import { loadLibrary } from "@/lib/library-analyze";
import { generateVariations } from "@/lib/variations";
import {
  PublishedSourceZ,
  VARIATION_STATUSES,
  VariationsZ,
  variationsPath,
  type PublishedSource,
  type Variations,
} from "@/lib/variations-schema";
import { ANALYSIS_DIR } from "@/lib/paths";


// One Gemini text call
export const maxDuration = 120;

async function loadVariations(videoId: string): Promise<Variations | null> {
  try {
    const raw = await fs.readFile(variationsPath(videoId), "utf8");
    return VariationsZ.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function loadAnalysis(videoId: string): Promise<Analysis | null> {
  try {
    const raw = await fs.readFile(join(ANALYSIS_DIR, `${videoId}.json`), "utf8");
    return AnalysisZ.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function loadRecs(videoId: string): Promise<ShotRecommendations | null> {
  try {
    const raw = await fs.readFile(
      join(ANALYSIS_DIR, `${videoId}.recommendations.json`),
      "utf8"
    );
    return ShotRecommendationsZ.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function saveVariations(stored: Variations): Promise<void> {
  const path = variationsPath(stored.videoId);
  await fs.mkdir(ANALYSIS_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(VariationsZ.parse(stored), null, 2));
  await fs.rename(tmp, path);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  const stored = await loadVariations(videoId);
  if (!stored) {
    return NextResponse.json(
      { error: "No variations generated for this video" },
      { status: 404 }
    );
  }
  return NextResponse.json(stored);
}

// Generate (or regenerate) suggestions. Body: { source } with the published
// post's stats — optional when a previous run already stored them.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let requestedModel: unknown;
  let source: PublishedSource | null = null;
  try {
    const body = await request.json().catch(() => null);
    requestedModel = body?.model;
    if (body?.source) source = PublishedSourceZ.parse(body.source);
  } catch {
    return NextResponse.json(
      { error: "source must match the published-post stats shape" },
      { status: 400 }
    );
  }
  const previous = await loadVariations(videoId);
  source = source ?? previous?.source ?? null;
  if (!source) {
    return NextResponse.json(
      {
        error:
          "No published-post stats for this video — start from the Iterate page so the stats come along",
      },
      { status: 400 }
    );
  }

  const analysis = await loadAnalysis(videoId);
  if (!analysis) {
    return NextResponse.json(
      { error: "Run the Gemini shot analysis first — no analysis found" },
      { status: 404 }
    );
  }

  let ai: GoogleGenAI;
  try {
    const model = await projectModel(videoId, requestedModel);
    ai = getGeminiClient(model);
    await saveProjectModel(videoId, model);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Gemini not configured" },
      { status: 500 }
    );
  }

  try {
    const [library, recs] = await Promise.all([loadLibrary(), loadRecs(videoId)]);
    const { suggestions, usage } = await generateVariations(
      ai,
      analysis,
      source,
      library,
      recs
    );
    const stored: Variations = {
      videoId,
      generatedAt: new Date().toISOString(),
      model: getGeminiModel(ai),
      source,
      suggestions,
      usage: usage
        ? {
            promptTokens: (usage.promptTokenCount as number) ?? undefined,
            outputTokens: (usage.candidatesTokenCount as number) ?? undefined,
            totalTokens: (usage.totalTokenCount as number) ?? undefined,
          }
        : undefined,
    };
    await saveVariations(stored);
    return NextResponse.json(stored);
  } catch (error) {
    console.error("variation generation failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Variation generation failed",
      },
      { status: 500 }
    );
  }
}

// Move one suggestion between proposed / applied / dismissed
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let id: unknown;
  let status: unknown;
  try {
    const body = await request.json();
    id = body.id;
    status = body.status;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (typeof id !== "string") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (
    typeof status !== "string" ||
    !(VARIATION_STATUSES as readonly string[]).includes(status)
  ) {
    return NextResponse.json(
      { error: `status must be one of ${VARIATION_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  const stored = await loadVariations(videoId);
  if (!stored) {
    return NextResponse.json(
      { error: "No variations generated for this video" },
      { status: 404 }
    );
  }
  const target = stored.suggestions.find((s) => s.id === id);
  if (!target) {
    return NextResponse.json({ error: "Unknown suggestion id" }, { status: 404 });
  }
  target.status = status as Variations["suggestions"][number]["status"];
  target.appliedAt = status === "applied" ? new Date().toISOString() : null;

  await saveVariations(stored);
  return NextResponse.json(stored);
}
