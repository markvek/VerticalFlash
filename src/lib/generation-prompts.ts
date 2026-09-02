import { createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { GEMINI_MODEL } from "./gemini";
import { getBrandConfig } from "./config";
import { productCharacter } from "./brand";
import type { Analysis } from "./analysis-schema";
import {
  GeminiGenPromptsZ,
  geminiGenPromptsResponseSchema,
} from "./generation-schema";

type AnalysisShot = Analysis["shots"][number];

export function shotDurationSeconds(shot: AnalysisShot): number {
  return Math.round((shot.end_time - shot.start_time) * 10) / 10;
}

// The fixed character sentence comes from brand.config.json: every prompt
// that shows the product must describe the same subject or the generated
// shots won't cut together.
function character(): string {
  return productCharacter(getBrandConfig());
}

function brandName(): string {
  return getBrandConfig().name;
}

function draftInstruction(
  analysis: Analysis,
  shots: AnalysisShot[]
): string {
  const shotList = shots.map((s) => ({
    shot_index: s.index,
    duration_s: shotDurationSeconds(s),
    description: s.description,
    camera_style: s.camera_style,
    time_of_day: s.time_of_day || undefined,
    spoken_text: s.spoken_text || undefined,
    on_screen_text: s.on_screen_text || undefined,
    tags: s.tags?.length ? s.tags : undefined,
  }));

  return `You write prompts for an AI text-to-video model. A content team is
remaking a successful TikTok ("${analysis.format}" format: ${analysis.summary})
using their own footage of the ${brandName()} product — ${character()}. For shots
where no real footage fits, an AI clip will be generated from your prompt.

For EACH shot below, write ONE self-contained video-generation prompt:
- Recast the shot's subject and action around the ${brandName()} product where the
  shot features a product; describe ${character()} verbatim in those
  prompts so every generated shot shows the same character.
- Name the camera work explicitly (e.g. "static locked-off shot",
  "slow handheld push-in", "smooth pan left") matching the shot's
  camera_style.
- Name the lighting/time of day matching the shot's time_of_day
  ("warm golden-hour light", "night, lit by street lamps",
  "soft indoor lighting").
- Always include: "vertical 9:16 smartphone footage, realistic,
  ultra-detailed" and the target length ("about <duration_s> seconds").
- Do NOT include any on-screen text, captions, subtitles, watermarks, or
  logos in the video — text is burned in later.
- No spoken dialogue; the clip's audio is discarded.
- One paragraph per shot, concrete and visual. No markdown.

Include every shot_index exactly once.

SHOTS:
${JSON.stringify(shotList, null, 1)}`;
}

export async function generateShotPrompts(
  ai: GoogleGenAI,
  analysis: Analysis,
  shotIndexes?: number[]
): Promise<{
  prompts: Map<number, string>;
  usage: Record<string, unknown> | undefined;
}> {
  const wanted = new Set(shotIndexes ?? analysis.shots.map((s) => s.index));
  const shots = analysis.shots.filter((s) => wanted.has(s.index));
  if (shots.length === 0) {
    return { prompts: new Map(), usage: undefined };
  }

  const basePrompt = draftInstruction(analysis, shots);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: Your previous response was rejected (${
            lastError instanceof Error ? lastError.message : "invalid JSON"
          }). Return ONLY valid JSON matching the provided schema.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([prompt]),
      config: {
        responseMimeType: "application/json",
        responseSchema: geminiGenPromptsResponseSchema,
      },
    });

    const rawText = response.text ?? "";
    try {
      const parsed = GeminiGenPromptsZ.parse(JSON.parse(rawText));
      const prompts = new Map<number, string>();
      for (const p of parsed.prompts) {
        if (wanted.has(p.shot_index) && p.prompt.trim()) {
          prompts.set(p.shot_index, p.prompt.trim());
        }
      }
      return {
        prompts,
        usage: response.usageMetadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `Generation prompt draft failed validation (attempt ${attempt + 1}):`,
        error,
        "\nraw:",
        rawText.slice(0, 2000)
      );
    }
  }

  throw new Error(
    `Gemini returned invalid generation prompts after retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

// Default continuation prompt when extending a too-short library clip
export function defaultExtendPrompt(
  shot: AnalysisShot,
  sourceDescription: string | null,
  secondsNeeded: number
): string {
  const scene = sourceDescription ? ` The clip shows: ${sourceDescription}` : "";
  return `Continue this exact scene seamlessly — same setting, subject, lighting,
and camera style, no cut or transition.${scene} Keep the action going naturally
(${shot.description}) for about ${Math.max(1, Math.ceil(secondsNeeded))} more
seconds. Vertical 9:16 smartphone footage, realistic. No on-screen text,
captions, or logos.`;
}

// Appended server-side when reference clips ride along; users never see or
// manage the <VIDEO_REF_N> tags.
export function referencePreamble(count: number): string {
  if (count <= 0) return "";
  const tags = Array.from({ length: count }, (_, i) => `<VIDEO_REF_${i}>`).join(
    ", "
  );
  return `\n\nThe attached reference clips (${tags}) show the real ${brandName()} product —
${character()}. Match its exact appearance, colors, and proportions in the
generated video.`;
}
