import { promises as fs } from "fs";
import { execFileAsync } from "./ffmpeg";
import { join } from "path";
import { tmpdir } from "os";
import { createPartFromUri, createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { getGeminiModel } from "./gemini";
import {
  geminiResponseSchema,
  GeminiAnalysisZ,
  type GeminiAnalysis,
} from "./analysis-schema";
import { validateShots } from "./shot-timing";
import { loadLibrary } from "./library-store";
import { getBrandConfig } from "./config";
import type { BriefProjectMeta } from "./project-meta";
import { musicPath } from "./music-library";

// Shot planning for projects that start from a brief (a song and/or a
// prompt) instead of a TikTok video. Gemini gets the creative brief, the
// exact target length, a summary of the brand footage library (so the
// plan is fillable), and — for music projects — the actual audio the video
// will use, so cuts land on the track's beats and phrases.

export interface CatalogSummary {
  filename: string;
  description: string;
  category: string;
  camera_action: string;
  time_of_day: string;
  duration_s: number | null;
  tags: string[];
}

export async function loadCatalogSummary(): Promise<CatalogSummary[]> {
  const library = await loadLibrary();
  return library.videos
    .filter((v) => v.analysis)
    .map((v) => ({
      filename: v.filename,
      description: v.analysis!.description,
      category: v.analysis!.category,
      camera_action: v.analysis!.camera_action,
      time_of_day: v.analysis!.time_of_day,
      duration_s: v.duration ?? null,
      tags: Array.from(
        new Set([...(v.tags || []), ...v.analysis!.suggested_tags])
      ).slice(0, 6),
    }));
}

// The exact audio the video will carry: the track trimmed to the target
// length, looped when the song is shorter. MP3 so Gemini's Files API
// accepts it as audio/mp3.
async function renderPlanAudio(
  trackFilename: string,
  duration: number,
  dest: string
): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-stream_loop",
    "-1",
    "-i",
    musicPath(trackFilename),
    "-t",
    duration.toFixed(3),
    "-vn",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    dest,
  ]);
}

function buildPrompt(
  meta: BriefProjectMeta,
  duration: number,
  catalog: CatalogSummary[],
  hasAudio: boolean
): string {
  const brief = meta.prompt.trim();
  const music = meta.music;
  const musicLine = music
    ? `"${music.title}"${music.author ? ` by ${music.author}` : ""} (${
        music.duration != null ? `${music.duration.toFixed(1)}s long` : "length unknown"
      }${
        music.duration != null && music.duration < duration
          ? ", looped to fill the video"
          : music.duration != null && music.duration > duration
            ? `, only the first ${duration.toFixed(1)}s are used`
            : ""
      })`
    : "none — the video is silent or gets a song later";

  const brand = getBrandConfig();
  return `You are planning a short-form TikTok video for "${brand.name}" — a brand whose
product is ${brand.product.description}. The video will be cut together from the team's own
footage library, so plan shots that this footage can actually fill.

TARGET LENGTH: exactly ${duration.toFixed(1)} seconds.
MUSIC: ${musicLine}
${
  hasAudio
    ? `The attached audio file is the EXACT soundtrack of the video (already
trimmed/looped to ${duration.toFixed(1)}s). Listen to it and pace the edit to
it: put cuts on beat drops, phrase boundaries, lyric lines, and energy
changes. Faster sections get shorter shots; the hook shot should land on
the opening musical moment. Describe the pacing decisions in
music_usage_note (e.g. "cuts on every second downbeat; the reveal lands on
the drop at 7.4s").`
    : `There is no soundtrack to listen to — pace the shots for a punchy,
scroll-stopping rhythm (shorter shots up front).`
}
CREATIVE BRIEF: ${brief || "(none given — choose a proven, fun format for the brand: a POV, a reveal, a montage, or a mini-skit featuring ${brand.product.shortName})"}

FOOTAGE LIBRARY (what exists; plan shots these clips can play):
${JSON.stringify(catalog, null, 0)}

Return JSON matching the provided schema:
- shots: 4-12 shots covering 0 → ${duration.toFixed(1)} with NO gaps, ascending,
  each at least 0.8s; the last shot's end_time must equal ${duration.toFixed(1)}.
  start_time/end_time are plain decimal SECONDS (never minutes or MM.SS).
  For each shot:
  - description: one sentence, max 15 words, of what we SEE — concrete
    enough to match a library clip (subject, action, setting).
  - on_screen_text: the text overlay for this shot (short, punchy, max 8
    words; empty string for none). The first shot should carry the hook.
  - spoken_text: voiceover for this shot, or empty string (prefer no
    voiceover unless the brief asks for one).
  - camera_style: one of "static", "handheld", "pan", "zoom", "pov",
    "screen_recording", "other".
  - time_of_day: keep the whole video consistent unless the brief needs a
    day/night shift — "morning", "midday", "afternoon", "golden_hour",
    "night", "indoor_lighting", or "unclear".
  - tags: 4-8 short lowercase tags for the shot, reusing the library's
    vocabulary where it fits (1-2 camera tags + content/setting/action tags).
- summary: 2 sentences on what the video is and why it should hold viewers
- hook_description: what the first 2 seconds do to stop the scroll
- format: one of "pov", "reveal", "transformation", "storytime", "haul",
  "tutorial", "skit", "reaction", "montage", "other"
- tags: 5-10 lowercase video-level tags
- music_usage: "background_music", "trending_sound_lipsync",
  "voiceover_over_music", "original_audio_talking", or "sound_effect_driven"
- music_usage_note: one sentence on how the cuts relate to the audio
- full_transcript: the lyrics/words heard in the used portion of the audio
  (empty string if none or if there is no audio)`;
}

export interface ShotPlanResult {
  analysis: GeminiAnalysis;
  shots: GeminiAnalysis["shots"];
  usage: Record<string, unknown> | undefined;
}

export async function planShotsFromBrief(
  ai: GoogleGenAI,
  meta: BriefProjectMeta,
  duration: number
): Promise<ShotPlanResult> {
  const catalog = await loadCatalogSummary();

  // Music projects: hand Gemini the real soundtrack
  let uploadedName: string | undefined;
  let audioPart: ReturnType<typeof createPartFromUri> | null = null;
  const tmpAudio = join(tmpdir(), `plan-${Date.now()}.mp3`);
  try {
    if (meta.music) {
      try {
        await renderPlanAudio(meta.music.filename, duration, tmpAudio);
        const uploaded = await ai.files.upload({
          file: tmpAudio,
          config: { mimeType: "audio/mp3" },
        });
        uploadedName = uploaded.name;
        let file = uploaded;
        const deadline = Date.now() + 120_000;
        while (file.state !== "ACTIVE") {
          if (file.state === "FAILED") {
            throw new Error("Gemini file processing failed");
          }
          if (Date.now() > deadline) {
            throw new Error("Timed out waiting for the audio upload");
          }
          await new Promise((r) => setTimeout(r, 2000));
          file = await ai.files.get({ name: uploadedName! });
        }
        audioPart = createPartFromUri(file.uri!, file.mimeType || "audio/mp3");
      } catch (error) {
        // Planning still works from the brief alone
        console.error("plan audio upload failed, planning without it:", error);
        audioPart = null;
      }
    }

    const basePrompt = buildPrompt(meta, duration, catalog, audioPart != null);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? basePrompt
          : `${basePrompt}\n\nIMPORTANT: Your previous response was rejected (${
              lastError instanceof Error ? lastError.message : "invalid JSON"
            }). Return ONLY valid JSON matching the provided schema. Timestamps
must be plain decimal seconds between 0 and ${duration.toFixed(1)}, with the
shots covering the whole length.`;

      const response = await ai.models.generateContent({
        model: getGeminiModel(ai),
        contents: createUserContent(audioPart ? [audioPart, prompt] : [prompt]),
        config: {
          responseMimeType: "application/json",
          responseSchema: geminiResponseSchema,
        },
      });

      const rawText = response.text ?? "";
      try {
        const analysis = GeminiAnalysisZ.parse(JSON.parse(rawText));
        const shots = validateShots(analysis.shots, duration);
        return {
          analysis,
          shots,
          usage: response.usageMetadata as Record<string, unknown> | undefined,
        };
      } catch (error) {
        lastError = error;
        console.error(
          `Shot plan failed validation (attempt ${attempt + 1}):`,
          error,
          "\nraw:",
          rawText.slice(0, 2000)
        );
      }
    }
    throw new Error(
      `Gemini returned an invalid shot plan after retry: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  } finally {
    await fs.unlink(tmpAudio).catch(() => {});
    if (uploadedName) {
      try {
        await ai.files.delete({ name: uploadedName });
      } catch (cleanupError) {
        console.error("Failed to delete Gemini file:", cleanupError);
      }
    }
  }
}
