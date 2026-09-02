import { createUserContent } from "@google/genai";
import { getBrandConfig } from "./config";
import type { GoogleGenAI } from "@google/genai";
import { GEMINI_MODEL } from "./gemini";
import type { Analysis } from "./analysis-schema";
import type { ShotRecommendations } from "./recommendation-schema";
import type { ClipLibrary } from "./library-schema";
import {
  GeminiVariationsZ,
  geminiVariationsResponseSchema,
  type GeminiVariations,
  type PublishedSource,
  type Variation,
} from "./variations-schema";

// Fix notes flow through the /edit-notes endpoint, which caps at 500 chars
const MAX_FIX_NOTE = 500;

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function ratio(value: number, reference: number): string {
  if (reference <= 0) return "n/a";
  return `${(value / reference).toFixed(1)}x`;
}

function describeStats(source: PublishedSource): string {
  const lines = [
    `- Views: ${source.viewCount.toLocaleString()}`,
    `- Likes: ${source.likeCount.toLocaleString()} (like rate ${pct(source.likeCount, source.viewCount)})`,
    `- Comments: ${source.commentCount.toLocaleString()} (comment rate ${pct(source.commentCount, source.viewCount)})`,
    `- Shares: ${source.shareCount.toLocaleString()} (share rate ${pct(source.shareCount, source.viewCount)})`,
    `- Length: ${source.duration}s`,
    source.completionRate != null
      ? `- Completion rate (average % of the video watched): ${source.completionRate.toFixed(1)}%`
      : "- Completion rate: not available (TikHub sync hasn't run)",
    source.newFollowersGained != null
      ? `- New followers from this post: ${source.newFollowersGained}`
      : null,
  ];
  if (source.benchmark) {
    const b = source.benchmark;
    lines.push(
      `- Account benchmark (${b.videoCount} posts): median views ${b.medianViews.toLocaleString()} — this post is ${ratio(source.viewCount, b.medianViews)} the median` +
        (b.medianCompletionRate != null && source.completionRate != null
          ? `; median completion ${b.medianCompletionRate.toFixed(1)}% vs this post's ${source.completionRate.toFixed(1)}%`
          : "")
    );
  }
  return lines.filter(Boolean).join("\n");
}

function buildPrompt(
  analysis: Analysis,
  source: PublishedSource,
  library: ClipLibrary,
  recs: ShotRecommendations | null
): string {
  const recsByShot = new Map(
    (recs?.shots ?? []).map((s) => [s.shot_index, s])
  );
  const shots = analysis.shots.map((s) => {
    const rs = recsByShot.get(s.index);
    const current =
      rs?.selected_filename ?? rs?.recommendations[0]?.filename ?? null;
    return {
      shot_index: s.index,
      start_s: Math.round(s.start_time * 10) / 10,
      duration_s: Math.round((s.end_time - s.start_time) * 10) / 10,
      description: s.description,
      on_screen_text: s.on_screen_text || undefined,
      spoken_text: s.spoken_text || undefined,
      camera: s.camera_style,
      time_of_day: s.time_of_day,
      current_clip: current ?? undefined,
    };
  });

  const catalog = library.videos
    .filter((v) => v.analysis)
    .map((v) => ({
      filename: v.filename,
      duration_s: v.duration ?? undefined,
      time_of_day: v.analysis!.time_of_day,
      category: v.analysis!.category,
      description: (v.description || v.analysis!.description).slice(0, 140),
    }));

  const brand = getBrandConfig();
  return `You are a short-form video strategist for the ${brand.name} brand account
(${brand.name}'s product is ${brand.product.description}). One of the account's own
published TikToks did well. The team will produce an ALTERNATE VERSION of
it — the same concept, re-assembled shot by shot from the ${brand.name} clip
library by an automated renderer — that keeps what worked and improves what
the numbers say was weak.

THE PUBLISHED POST
- Caption as posted: ${source.title || "(none)"}
- Posted: ${new Date(source.createTime * 1000).toISOString().slice(0, 10)}
${describeStats(source)}

HOW TO READ THE STATS
- Completion rate below ~40%, or below the account median, means viewers
  left early: prioritize hook and pacing fixes and say where they likely
  dropped off (early shots vs. a slow middle).
- High views with a low like or share rate means the payoff or framing
  under-delivered: suggest a stronger ending shot and a caption angle.
- A high share rate means the concept travels: keep it, vary the hook and
  caption so the alternate doesn't feel like a repost.
- A high comment rate means the caption/on-screen question worked: carry a
  question forward, but change it.
- When completion is unavailable, reason from views vs. the account median
  and the engagement rates.

THE VIDEO (${analysis.format} format, ${analysis.shots.length} shots)
- Summary: ${analysis.summary}
- Hook: ${analysis.hook_description}
- Music: ${analysis.music.usage}${analysis.music.usage_note ? ` — ${analysis.music.usage_note}` : ""}
- Transcript: ${analysis.full_transcript || "(no speech)"}
- Shots (current_clip = the library clip the renderer would use today):
${JSON.stringify(shots, null, 1)}

LIBRARY (the only footage available for the alternate version):
${JSON.stringify(catalog, null, 1)}

RENDERER ABILITIES — a fix_note is executed by an automated renderer that
can ONLY:
- put a specific library clip in a shot (name the EXACT filename from
  LIBRARY)
- fill a shot longer than its clip by freezing the last frame, looping the
  clip, or slowing it down
- start the clip at a given second within the clip ("start at 3s")
- reuse a clip already used by another shot
- allow lighting (day/night) that differs from the rest of the video
It can NOT change shot durations, reorder shots, add shots, change text,
captions, music, or speed up footage. Every fix_note must be one short
sentence using only those abilities, e.g. "use IMG_0072.mp4 and start at
2s" or "loop the clip to fill the shot". Leave fix_note empty when the idea
needs anything else — the suggestion is then shown to the editor as advice.

Return 6-10 suggestions, at least one of each kind:
- hook: what should happen in the first 1-2 seconds of the alternate
  version to stop the scroll harder than the original did. If a library
  clip would make a better opening shot, put it in fix_note (shot_index 0
  or the first shot). Put a suggested opening on-screen text in "text".
- shot_swap: a specific shot whose footage should change, with the library
  clip to use (fix_note + clip). Prefer clips that show the duck clearly,
  match the shot's lighting, and are long enough for the shot.
- caption: a complete alternate caption in "text" (sound like a creator,
  not a brand ad; under 150 characters; no hashtags), with the angle in
  title and the stats reasoning in rationale. shot_index -1.
- pacing: where the cut feels slow or rushed given the completion data.
  When it can be expressed as a clip start point or fill mode on one
  shot, put that in fix_note; otherwise advisory with shot_index -1.

Rules:
- rationale MUST cite a concrete number from the stats above.
- Do not suggest the same clip for two different shots.
- Do not restate what the original already does well as a change.
- Titles are imperative and specific ("Open on the duck hitting the
  dashboard", not "Improve the hook").`;
}

export async function generateVariations(
  ai: GoogleGenAI,
  analysis: Analysis,
  source: PublishedSource,
  library: ClipLibrary,
  recs: ShotRecommendations | null
): Promise<{
  suggestions: Variation[];
  usage: Record<string, unknown> | undefined;
}> {
  const basePrompt = buildPrompt(analysis, source, library, recs);
  let parsed: GeminiVariations | null = null;
  let usage: Record<string, unknown> | undefined;
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
        responseSchema: geminiVariationsResponseSchema,
      },
    });
    const rawText = response.text ?? "";
    try {
      parsed = GeminiVariationsZ.parse(JSON.parse(rawText));
      usage = response.usageMetadata as Record<string, unknown> | undefined;
    } catch (error) {
      lastError = error;
      console.error(
        `Variation response failed validation (attempt ${attempt + 1}):`,
        error,
        "\nraw:",
        rawText.slice(0, 2000)
      );
    }
  }
  if (!parsed) {
    throw new Error(
      `Gemini returned invalid variations after retry: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }

  const libraryFiles = new Set(library.videos.map((v) => v.filename));
  const shotCount = analysis.shots.length;

  const suggestions: Variation[] = parsed.suggestions.map((s, i) => {
    const shotIndex =
      Number.isInteger(s.shot_index) && s.shot_index >= 0 && s.shot_index < shotCount
        ? s.shot_index
        : null;
    let clip: string | null = s.clip.trim() || null;
    let fixNote: string | null = s.fix_note.trim().slice(0, MAX_FIX_NOTE) || null;
    // A note that names footage we don't have would only produce a render
    // warning — demote it to advice. Captions are never renderer work.
    if (clip && !libraryFiles.has(clip)) {
      clip = null;
      fixNote = null;
    }
    if (s.kind === "caption" || shotIndex === null) fixNote = null;
    return {
      id: `${s.kind}-${i + 1}`,
      kind: s.kind,
      shot_index: shotIndex,
      title: s.title.trim(),
      rationale: s.rationale.trim(),
      fix_note: fixNote,
      clip,
      text: s.text.trim() || null,
      status: "proposed",
      appliedAt: null,
    };
  });

  return { suggestions, usage };
}
