import { NextRequest, NextResponse } from "next/server";
import { execFileAsync, ensureFfmpeg, ffmpegErrorResponse } from "@/lib/ffmpeg";
import { promises as fs } from "fs";
import { join } from "path";
import { getGeminiClient, GEMINI_MODEL } from "@/lib/gemini";
import {
  geminiResponseSchema,
  GeminiAnalysisZ,
  type GeminiAnalysis,
  type Analysis,
} from "@/lib/analysis-schema";
import { validateShots } from "@/lib/validate-shots";
import { createPartFromUri, createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { readProjectMeta } from "@/lib/project-meta";
import { planShotsFromBrief } from "@/lib/shot-plan";
import { ANALYSIS_DIR, DOWNLOADS_DIR } from "@/lib/paths";

// Gemini upload + video analysis can take a while
export const maxDuration = 300;

interface VideoMetadata {
  caption?: string;
  coTags?: Array<{ name: string }>;
  musicTitle?: string;
  musicAuthor?: string;
}

async function findVideoFile(videoId: string): Promise<string | null> {
  const files = await fs.readdir(DOWNLOADS_DIR).catch(() => [] as string[]);
  const match = files.find((f) => {
    const lower = f.toLowerCase();
    return (
      lower.endsWith(`_${videoId}.mp4`) ||
      lower.endsWith(`_${videoId}.mov`) ||
      lower === `${videoId}.mp4` ||
      lower === `${videoId}.mov`
    );
  });
  return match ? join(DOWNLOADS_DIR, match) : null;
}

async function readMetadata(videoPath: string): Promise<VideoMetadata> {
  try {
    const raw = await fs.readFile(`${videoPath}.metadata.json`, "utf8");
    return JSON.parse(raw) as VideoMetadata;
  } catch {
    return {};
  }
}

async function getVideoDuration(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    videoPath,
  ]);
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine video duration for ${videoPath}`);
  }
  return duration;
}

function buildPrompt(meta: VideoMetadata, duration: number): string {
  const caption = meta.caption || "(not available)";
  const hashtags =
    meta.coTags?.map((t) => `#${t.name}`).join(" ") || "(not available)";
  const musicTitle = meta.musicTitle || "(not available)";
  const musicAuthor = meta.musicAuthor || "(not available)";

  return `You are analyzing a short-form TikTok video for a content team studying
successful formats. The video is exactly ${duration.toFixed(1)} seconds long.
The video's platform metadata:
- Caption: ${caption}
- Hashtags: ${hashtags}
- Music (from TikTok metadata): ${musicTitle} by ${musicAuthor}

Analyze the ENTIRE video and return JSON matching the provided schema:

1. SHOTS: Break the video into distinct shots/scenes (a shot changes on a
   camera cut, location change, or major visual transition). For each shot:
   - start_time and end_time as plain decimal SECONDS from video start
     (e.g. 1.8 means 1.8 seconds; 12.5 means twelve and a half seconds).
     Do NOT use minutes or MM.SS notation. The last shot's end_time must
     equal the video duration (${duration.toFixed(1)})
   - description: one sentence, max 15 words, of what we SEE
   - on_screen_text: any text overlay/caption visible during this shot,
     verbatim (empty string if none)
   - spoken_text: what is SAID during this shot — voiceover or person
     talking, verbatim transcript (empty string if none)
   - camera_style: one of "static", "handheld", "pan", "zoom", "pov",
     "screen_recording", "other"
   - time_of_day: judge from lighting — "morning", "midday", "afternoon",
     "golden_hour", "night", "indoor_lighting" (artificial light, can't
     judge), or "unclear"
   - tags: 4-8 short lowercase tags for this specific shot. ALWAYS include
     1-2 tags describing the camera movement/technique — be specific about
     direction and motion (e.g. "zoom in", "zoom out", "pan left",
     "pan right", "tilt up", "stable shot", "handheld", "tracking shot",
     "slow push in"). The rest cover the shot's content, objects, setting,
     and action (e.g. "store shelf", "steering wheel cover", "pink",
     "hand held product", "unboxing")
   Rules: cover the full duration with no gaps; if the video is one
   continuous take, return it as one shot; merge cuts shorter than 0.5s
   into their neighbor; maximum 15 shots — merge similar adjacent shots
   if there would be more.

2. VIDEO-LEVEL FIELDS:
   - summary: 2 sentences on what happens and why it likely engages viewers
   - hook_description: what happens in the first 2 seconds to stop scrolling
   - format: one of "pov", "reveal", "transformation", "storytime", "haul",
     "tutorial", "skit", "reaction", "montage", "other"
   - tags: 5-10 short lowercase tags describing content, objects, setting,
     vibe (e.g. "tesla interior", "plush toy", "night drive", "humor")
   - music_usage: how the audio is used — one of "background_music",
     "trending_sound_lipsync", "voiceover_over_music", "original_audio_talking",
     "sound_effect_driven" — plus one sentence on how audio and cuts interact
     (e.g. "cuts land on the beat drops")
   - full_transcript: complete spoken transcript of the video in order
     (empty string if no speech)

Transcribe speech and on-screen text exactly as heard/shown. Do not invent
content. If audio is music-only with no speech, say so via empty transcripts.`;
}

function parseAnalysis(rawText: string): GeminiAnalysis {
  const parsed = JSON.parse(rawText);
  return GeminiAnalysisZ.parse(parsed);
}

async function extractScreenshots(
  videoPath: string,
  videoId: string,
  shots: GeminiAnalysis["shots"],
  duration: number
): Promise<void> {
  const shotsDir = join(ANALYSIS_DIR, videoId);
  // Re-runs replace the whole shots directory
  await fs.rm(shotsDir, { recursive: true, force: true });
  await fs.mkdir(shotsDir, { recursive: true });

  for (let i = 0; i < shots.length; i++) {
    const midpoint = Math.min(
      (shots[i].start_time + shots[i].end_time) / 2,
      Math.max(duration - 0.1, 0)
    );
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      midpoint.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      join(shotsDir, `shot_${i}.jpg`),
    ]);
  }
}

async function generateAnalysis(
  ai: GoogleGenAI,
  fileUri: string,
  mimeType: string,
  meta: VideoMetadata,
  duration: number
): Promise<{
  analysis: GeminiAnalysis;
  shots: GeminiAnalysis["shots"];
  usage: Record<string, unknown> | undefined;
}> {
  const basePrompt = buildPrompt(meta, duration);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: Your previous response was rejected (${
            lastError instanceof Error ? lastError.message : "invalid JSON"
          }). Return ONLY valid JSON matching the provided schema. Timestamps
must be plain decimal seconds between 0 and ${duration.toFixed(1)}.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([
        createPartFromUri(fileUri, mimeType),
        prompt,
      ]),
      config: {
        responseMimeType: "application/json",
        responseSchema: geminiResponseSchema,
      },
    });

    const rawText = response.text ?? "";
    try {
      const analysis = parseAnalysis(rawText);
      const shots = validateShots(analysis.shots, duration);
      return {
        analysis,
        shots,
        usage: response.usageMetadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `Gemini response failed validation (attempt ${attempt + 1}):`,
        error,
        "\nraw:",
        rawText.slice(0, 2000)
      );
    }
  }

  throw new Error(
    `Gemini returned an invalid analysis after retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  try {
    const raw = await fs.readFile(
      join(ANALYSIS_DIR, `${videoId}.json`),
      "utf8"
    );
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json(
      { error: "No analysis found for this video" },
      { status: 404 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;

  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  try {
    await ensureFfmpeg();
  } catch (error) {
    return ffmpegErrorResponse(error)!;
  }

  const videoPath = await findVideoFile(videoId);
  if (!videoPath) {
    return NextResponse.json(
      { error: `No downloaded mp4 found for video ${videoId}` },
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

  const meta = await readMetadata(videoPath);
  // Projects started from a brief (/create) have a placeholder source —
  // their shots are planned from the brief and the song, not from footage
  const project = await readProjectMeta(videoPath);

  let uploadedName: string | undefined;
  try {
    const duration = await getVideoDuration(videoPath);

    let analysis: GeminiAnalysis;
    let shots: GeminiAnalysis["shots"];
    let usage: Record<string, unknown> | undefined;
    if (project) {
      ({ analysis, shots, usage } = await planShotsFromBrief(
        ai,
        project,
        duration
      ));
    } else {
      // Upload via Files API and poll until the file is ACTIVE
      const uploaded = await ai.files.upload({
        file: videoPath,
        config: { mimeType: "video/mp4" },
      });
      uploadedName = uploaded.name;

      let file = uploaded;
      const deadline = Date.now() + 120_000;
      while (file.state !== "ACTIVE") {
        if (file.state === "FAILED") {
          throw new Error("Gemini file processing failed");
        }
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for Gemini file to become ACTIVE");
        }
        await new Promise((r) => setTimeout(r, 2000));
        file = await ai.files.get({ name: uploadedName! });
      }

      ({ analysis, shots, usage } = await generateAnalysis(
        ai,
        file.uri!,
        file.mimeType || "video/mp4",
        meta,
        duration
      ));
    }

    await extractScreenshots(videoPath, videoId, shots, duration);

    const stored: Analysis = {
      videoId,
      analyzedAt: new Date().toISOString(),
      model: GEMINI_MODEL,
      summary: analysis.summary,
      hook_description: analysis.hook_description,
      format: analysis.format,
      tags: analysis.tags,
      music: {
        title: project?.music?.title ?? meta.musicTitle ?? "",
        author: project?.music?.author ?? meta.musicAuthor ?? "",
        usage: analysis.music_usage,
        usage_note: analysis.music_usage_note,
      },
      full_transcript: analysis.full_transcript,
      shots: shots.map((shot, i) => ({
        index: i,
        ...shot,
        screenshot: `/api/analysis-shot/${videoId}/${i}`,
      })),
      usage: usage
        ? {
            promptTokens: (usage.promptTokenCount as number) ?? undefined,
            outputTokens: (usage.candidatesTokenCount as number) ?? undefined,
            totalTokens: (usage.totalTokenCount as number) ?? undefined,
          }
        : undefined,
    };

    await fs.mkdir(ANALYSIS_DIR, { recursive: true });
    await fs.writeFile(
      join(ANALYSIS_DIR, `${videoId}.json`),
      JSON.stringify(stored, null, 2)
    );

    return NextResponse.json(stored);
  } catch (error) {
    console.error("analyze failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 500 }
    );
  } finally {
    // Never leave uploads behind on Gemini storage
    if (uploadedName) {
      try {
        await ai.files.delete({ name: uploadedName });
      } catch (cleanupError) {
        console.error("Failed to delete Gemini file:", cleanupError);
      }
    }
  }
}
