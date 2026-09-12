import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import type { GoogleGenAI } from "@google/genai";
import { getGeminiClient, GEMINI_MODEL } from "@/lib/gemini";
import { AnalysisZ, type Analysis } from "@/lib/analysis-schema";
import { generateShotPrompts } from "@/lib/generation-prompts";
import { classifyGeminiError } from "@/lib/library-analyze";
import {
  loadGenerations,
  mutateGenerations,
  getOrCreateShot,
} from "@/lib/generation-store";
import { ANALYSIS_DIR } from "@/lib/paths";


const ERROR_STATUS: Record<string, number> = {
  rate_limit: 429,
  daily_quota: 429,
  unavailable: 503,
  fatal: 500,
};

async function loadAnalysis(videoId: string): Promise<Analysis | null> {
  try {
    const raw = await fs.readFile(join(ANALYSIS_DIR, `${videoId}.json`), "utf8");
    return AnalysisZ.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Draft generation prompts for all shots (or one). User-edited prompts are
// kept unless the request says {force: true}.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let shotIndex: number | null = null;
  let force = false;
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.shot_index === "number") shotIndex = body.shot_index;
    force = body.force === true;
  } catch {
    // empty body = draft everything
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
    ai = getGeminiClient();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Gemini not configured" },
      { status: 500 }
    );
  }

  const generations = await loadGenerations(videoId);

  // Which shots need a draft: the requested one, or every shot without a
  // user-authored prompt (unless forced)
  const targets = analysis.shots
    .map((s) => s.index)
    .filter((index) => {
      if (shotIndex !== null && index !== shotIndex) return false;
      if (force || shotIndex !== null) return true;
      const existing = generations.shots[String(index)];
      return !existing || existing.prompt_source !== "user" || !existing.prompt;
    });

  if (targets.length === 0) {
    return NextResponse.json(generations);
  }

  try {
    const { prompts, usage } = await generateShotPrompts(ai, analysis, targets);
    const latest = await mutateGenerations(videoId, current => {
    for (const [index, prompt] of prompts) {
      const shot = getOrCreateShot(current, index);
      if (shot.prompt !== (generations.shots[String(index)]?.prompt ?? "")) continue;
      shot.prompt = prompt;
      shot.prompt_source = "gemini";
    }
    current.promptsGeneratedAt = new Date().toISOString();
    current.promptModel = GEMINI_MODEL;
    if (usage) {
      current.promptUsage = {
        promptTokens:
          ((current.promptUsage?.promptTokens ?? 0) +
            ((usage.promptTokenCount as number) ?? 0)) || undefined,
        outputTokens:
          ((current.promptUsage?.outputTokens ?? 0) +
            ((usage.candidatesTokenCount as number) ?? 0)) || undefined,
        totalTokens:
          ((current.promptUsage?.totalTokens ?? 0) +
            ((usage.totalTokenCount as number) ?? 0)) || undefined,
      };
    }
    });
    return NextResponse.json(latest);
  } catch (error) {
    console.error("generation prompt drafting failed:", error);
    const { kind, retryAfterMs } = classifyGeminiError(error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Prompt drafting failed",
        kind,
        retryAfterMs,
      },
      { status: ERROR_STATUS[kind] ?? 500 }
    );
  }
}
