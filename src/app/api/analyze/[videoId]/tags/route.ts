import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { getGeminiClient, GEMINI_MODEL } from "@/lib/gemini";
import {
  AnalysisZ,
  GeminiShotTagsZ,
  geminiShotTagsResponseSchema,
  type Analysis,
  type GeminiShotTags,
} from "@/lib/analysis-schema";
import { getTagFacets } from "@/lib/tag-vocabulary";
import { getBrandConfig } from "@/lib/config";
import {
  createPartFromBase64,
  createUserContent,
  type PartUnion,
} from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { ANALYSIS_DIR } from "@/lib/paths";


// Single inline Gemini call over the shot screenshots — no Files API polling
export const maxDuration = 120;

const MAX_TAGS_PER_SHOT = 10;

function buildInstructions(shotCount: number): string {
  const vocabulary = Object.entries(getTagFacets(getBrandConfig()))
    .map(([facet, tags]) => `- ${facet}: ${tags.join(", ")}`)
    .join("\n");

  return `You are tagging the shots of a short-form TikTok video for a content
team that matches them against their own footage library by exact tag
intersection. Each shot below comes with its text context (description,
on-screen text, spoken text, camera style) and, where available, a still
frame from the shot's midpoint.

CONTROLLED VOCABULARY, by facet:
${vocabulary}

For EVERY shot, return 4-8 short lowercase tags:
- Prefer vocabulary terms VERBATIM — exact spelling matters for matching.
- Apply every vocabulary tag that genuinely fits the shot (synonym pairs
  like "interior" and "car interior" may both appear).
- Include at least one subject tag, one setting tag, and one camera tag.
- The still frames cannot show motion — derive camera tags from the given
  camera_style and description (e.g. camera_style "pan" with "pans across
  shelves" → "pan left" or "pan right"; "static" → "static shot").
- You may add up to 2 free-form tags per shot for salient specifics the
  vocabulary misses (e.g. a color, a brand, a distinctive object).
- Do not invent content: tag only what the frame or text context supports.

Return JSON matching the provided schema with every shot_index from the
input (0 through ${shotCount - 1}) exactly once.`;
}

function buildContents(
  analysis: Analysis,
  screenshots: Map<number, Buffer>
): PartUnion[] {
  const parts: PartUnion[] = [buildInstructions(analysis.shots.length)];

  for (const shot of analysis.shots) {
    parts.push(
      `SHOT ${shot.index}: ${JSON.stringify({
        shot_index: shot.index,
        description: shot.description,
        on_screen_text: shot.on_screen_text,
        spoken_text: shot.spoken_text,
        camera_style: shot.camera_style,
      })}`
    );
    const jpeg = screenshots.get(shot.index);
    if (jpeg) {
      parts.push(createPartFromBase64(jpeg.toString("base64"), "image/jpeg"));
    } else {
      parts.push("(no screenshot available for this shot — use the text context)");
    }
  }

  return parts;
}

function validateShotTags(parsed: GeminiShotTags, analysis: Analysis): void {
  const returned = new Set(parsed.shots.map((s) => s.shot_index));
  const missing = analysis.shots
    .map((s) => s.index)
    .filter((i) => !returned.has(i));
  if (missing.length) {
    throw new Error(`Response is missing shot_index ${missing.join(", ")}`);
  }
}

async function generateShotTags(
  ai: GoogleGenAI,
  analysis: Analysis,
  screenshots: Map<number, Buffer>
): Promise<{
  shotTags: GeminiShotTags;
  usage: Record<string, unknown> | undefined;
}> {
  const baseParts = buildContents(analysis, screenshots);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const parts =
      attempt === 0
        ? baseParts
        : [
            ...baseParts,
            `IMPORTANT: Your previous response was rejected (${
              lastError instanceof Error ? lastError.message : "invalid JSON"
            }). Return ONLY valid JSON matching the provided schema, with
every shot_index from the input exactly once.`,
          ];

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent(parts),
      config: {
        responseMimeType: "application/json",
        responseSchema: geminiShotTagsResponseSchema,
      },
    });

    const rawText = response.text ?? "";
    try {
      const shotTags = GeminiShotTagsZ.parse(JSON.parse(rawText));
      validateShotTags(shotTags, analysis);
      return {
        shotTags,
        usage: response.usageMetadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `Shot tag response failed validation (attempt ${attempt + 1}):`,
        error,
        "\nraw:",
        rawText.slice(0, 2000)
      );
    }
  }

  throw new Error(
    `Gemini returned invalid shot tags after retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))
  ).slice(0, MAX_TAGS_PER_SHOT);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;

  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
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

  let ai: GoogleGenAI;
  try {
    ai = getGeminiClient();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Gemini not configured" },
      { status: 500 }
    );
  }

  try {
    const screenshots = new Map<number, Buffer>();
    for (const shot of analysis.shots) {
      const jpeg = await fs
        .readFile(join(ANALYSIS_DIR, videoId, `shot_${shot.index}.jpg`))
        .catch(() => null);
      if (jpeg) screenshots.set(shot.index, jpeg);
    }

    const { shotTags, usage } = await generateShotTags(
      ai,
      analysis,
      screenshots
    );

    const tagsByIndex = new Map(
      shotTags.shots.map((s) => [s.shot_index, normalizeTags(s.tags)])
    );

    const stored: Analysis = {
      ...analysis,
      shots: analysis.shots.map((shot) => ({
        ...shot,
        tags: tagsByIndex.get(shot.index) ?? shot.tags,
      })),
      taggedAt: new Date().toISOString(),
      tagModel: GEMINI_MODEL,
      tagUsage: usage
        ? {
            promptTokens: (usage.promptTokenCount as number) ?? undefined,
            outputTokens: (usage.candidatesTokenCount as number) ?? undefined,
            totalTokens: (usage.totalTokenCount as number) ?? undefined,
          }
        : undefined,
    };

    await fs.writeFile(
      join(ANALYSIS_DIR, `${videoId}.json`),
      JSON.stringify(stored, null, 2)
    );

    return NextResponse.json(stored);
  } catch (error) {
    console.error("shot tagging failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Shot tagging failed" },
      { status: 500 }
    );
  }
}
