import { z } from "zod";
import { Type, createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { GEMINI_MODEL } from "./gemini";
import type { Analysis } from "./analysis-schema";
import type { ShotRecommendations } from "./recommendation-schema";
import type { ClipLibrary } from "./library-schema";

export const EDIT_FILLS = ["freeze", "loop", "slow_mo"] as const;
export type EditFill = (typeof EDIT_FILLS)[number];

// A user's free-text fix note, translated into what the renderer can do
export interface EditDirective {
  shot_index: number;
  clip: string | null;
  fill: EditFill | null;
  trim_start: number | null;
  allow_reuse: boolean;
  ignore_time_of_day: boolean;
  summary: string;
}

const GeminiDirectivesZ = z.object({
  directives: z.array(
    z.object({
      shot_index: z.number(),
      action: z.enum(["use_clip", "keep_auto", "unsupported"]),
      clip: z.string(),
      fill: z.enum(["freeze", "loop", "slow_mo", "none"]),
      trim_start: z.number(),
      allow_reuse: z.boolean(),
      ignore_time_of_day: z.boolean(),
      summary: z.string(),
    })
  ),
});

type GeminiDirectives = z.infer<typeof GeminiDirectivesZ>;

// Gemini structured-output schema — keep in sync with GeminiDirectivesZ
const geminiDirectivesResponseSchema = {
  type: Type.OBJECT,
  required: ["directives"],
  properties: {
    directives: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "shot_index",
          "action",
          "clip",
          "fill",
          "trim_start",
          "allow_reuse",
          "ignore_time_of_day",
          "summary",
        ],
        properties: {
          shot_index: {
            type: Type.NUMBER,
            description: "0-based shot index, copied exactly from the input",
          },
          action: {
            type: Type.STRING,
            enum: ["use_clip", "keep_auto", "unsupported"],
          },
          clip: {
            type: Type.STRING,
            description:
              "Exact filename from the library list when the note names or describes a specific clip; empty string otherwise",
          },
          fill: {
            type: Type.STRING,
            enum: ["freeze", "loop", "slow_mo", "none"],
            description:
              "How to make a too-short clip cover the shot, when the note asks for it",
          },
          trim_start: {
            type: Type.NUMBER,
            description:
              "Start point within the clip in plain decimal seconds, or -1 when the note doesn't give one",
          },
          allow_reuse: { type: Type.BOOLEAN },
          ignore_time_of_day: { type: Type.BOOLEAN },
          summary: {
            type: Type.STRING,
            description:
              "One short sentence: what will be done, or why the request is unsupported",
          },
        },
      },
    },
  },
};

function buildPrompt(
  analysis: Analysis,
  recs: ShotRecommendations,
  library: ClipLibrary,
  notes: Record<string, string>
): { prompt: string; notedIndexes: number[] } {
  const recsByShot = new Map(recs.shots.map((s) => [s.shot_index, s]));
  const notedIndexes: number[] = [];
  const notedShots = [];
  for (const [key, note] of Object.entries(notes)) {
    const idx = Number(key);
    const shot = analysis.shots.find((s) => s.index === idx);
    if (!shot) continue;
    notedIndexes.push(idx);
    const rs = recsByShot.get(idx);
    notedShots.push({
      shot_index: idx,
      duration_s: Math.round((shot.end_time - shot.start_time) * 10) / 10,
      description: shot.description,
      selected_clip: rs?.selected_filename ?? undefined,
      recommended_clips: rs?.recommendations.map((r) => ({
        filename: r.filename,
        duration_s: r.duration ?? undefined,
      })),
      user_note: note,
    });
  }

  const catalog = library.videos
    .filter((v) => v.analysis)
    .map((v) => ({
      filename: v.filename,
      duration_s: v.duration ?? undefined,
      time_of_day: v.analysis!.time_of_day,
      description: (v.description || v.analysis!.description).slice(0, 120),
    }));

  const prompt = `You translate a video editor's free-text fix notes into structured
directives for an automated clip-assembly renderer. The renderer remakes a
reference video by placing one library clip per shot, cut to the shot's
exact duration.

The renderer's ONLY abilities are:
- clip: place a specific library clip in the shot (exact filename from the
  LIBRARY list; empty string to keep the automatic choice)
- fill: cover a shot longer than its clip — "freeze" (hold the last frame),
  "loop" (repeat the clip), "slow_mo" (slow the clip down to fit), or "none".
  With "none" the renderer's default applies: the clip plays its footage and
  the remaining time is black — so a note asking for a black gap needs no
  fill directive.
- trim_start: start the clip window at a given second within the clip
- allow_reuse: permit a clip that is already used by another shot
- ignore_time_of_day: permit lighting (day/night) that differs from the
  rest of the video for this shot

Rules:
- Include every noted shot_index exactly once.
- action "use_clip" when the note names or clearly describes one library
  clip (copy its filename EXACTLY from the LIBRARY list); "keep_auto" when
  the note only adjusts how the automatic choice is used; "unsupported"
  when the note needs abilities not listed above (say why in summary, and
  set every other field to its empty/none/-1/false value).
- fill "none" and trim_start -1 unless the note asks for them.
- summary: one short imperative sentence of what will be done.

NOTED SHOTS:
${JSON.stringify(notedShots, null, 1)}

LIBRARY:
${JSON.stringify(catalog, null, 1)}`;

  return { prompt, notedIndexes };
}

export async function interpretEditNotes(
  ai: GoogleGenAI,
  analysis: Analysis,
  recs: ShotRecommendations,
  library: ClipLibrary,
  notes: Record<string, string>
): Promise<{ directives: Map<number, EditDirective>; warnings: string[] }> {
  const warnings: string[] = [];
  for (const key of Object.keys(notes)) {
    if (!analysis.shots.some((s) => s.index === Number(key))) {
      warnings.push(
        `Fix note for shot ${Number(key) + 1} ignored — that shot no longer exists in the analysis`
      );
    }
  }

  const { prompt: basePrompt, notedIndexes } = buildPrompt(
    analysis,
    recs,
    library,
    notes
  );
  if (notedIndexes.length === 0) {
    return { directives: new Map(), warnings };
  }

  let parsed: GeminiDirectives | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
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
        responseSchema: geminiDirectivesResponseSchema,
      },
    });
    const rawText = response.text ?? "";
    try {
      parsed = GeminiDirectivesZ.parse(JSON.parse(rawText));
    } catch (error) {
      lastError = error;
      console.error(
        `Fix-note interpretation failed validation (attempt ${attempt + 1}):`,
        error,
        "\nraw:",
        rawText.slice(0, 2000)
      );
    }
  }
  if (!parsed) {
    throw new Error(
      `Gemini returned invalid directives after retry: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }

  const libraryFiles = new Set(library.videos.map((v) => v.filename));
  const noted = new Set(notedIndexes);
  const directives = new Map<number, EditDirective>();

  for (const d of parsed.directives) {
    if (!noted.has(d.shot_index)) continue;
    if (d.action === "unsupported") {
      warnings.push(`Shot ${d.shot_index + 1} fix note not applied: ${d.summary}`);
      continue;
    }
    let clip: string | null = null;
    if (d.action === "use_clip" && d.clip) {
      if (!libraryFiles.has(d.clip)) {
        warnings.push(
          `Shot ${d.shot_index + 1} fix note: clip "${d.clip}" is not in the library — note skipped`
        );
        continue;
      }
      clip = d.clip;
    }
    const directive: EditDirective = {
      shot_index: d.shot_index,
      clip,
      fill: d.fill === "none" ? null : d.fill,
      trim_start: d.trim_start >= 0 ? d.trim_start : null,
      allow_reuse: d.allow_reuse,
      ignore_time_of_day: d.ignore_time_of_day,
      summary: d.summary,
    };
    const actionable =
      directive.clip != null ||
      directive.fill != null ||
      directive.trim_start != null ||
      directive.allow_reuse ||
      directive.ignore_time_of_day;
    if (!actionable) {
      warnings.push(
        `Shot ${d.shot_index + 1} fix note had no applicable effect: ${d.summary}`
      );
      continue;
    }
    directives.set(d.shot_index, directive);
  }

  return { directives, warnings };
}
