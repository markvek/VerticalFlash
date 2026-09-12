import { assertAnalysisReplaceable } from "./analysis-replacement";
import { promises as fs } from "fs";
import { createPartFromUri, createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { getGeminiModel } from "./gemini";
import { getBrandConfig } from "./config";
import type { Analysis, GeminiAnalysis } from "./analysis-schema";
import type { MasterProjectMeta, TimingSource } from "./project-meta";
import {
  GeminiTimeSegmentsZ,
  GeminiWordSegmentsZ,
  MasterSegmentsZ,
  geminiTimeSegmentsResponseSchema,
  geminiWordSegmentsResponseSchema,
  type GeminiTimeSegments,
  type GeminiWordSegments,
  type MasterSegments,
  type Segment,
  type Sentence,
  type Word,
} from "./segments-schema";
import { resolveTimingEngine } from "./whisperx";
import { ANALYSIS_DIR, analysisPath, sidecarPath } from "./paths";
import { extractScreenshots } from "./analysis-screenshots";
import { transcribeWithWhisperX } from "./transcribe-whisperx";
import {
  detectSilences,
  formatNumberedTranscript,
  rangeToTimes,
  snapToSilence,
  wordsToText,
} from "./word-timing";

// Analysis of a "master" (the storyboard flow's long-form source): timing
// from WhisperX (word-level) or Gemini (approximate), then one Gemini call
// that reads the transcript into segments with roles and hook scores.
// Writes analysis/<id>.segments.json and returns the pieces the analyze
// route needs to also write a standard Analysis (so the editor opens it).

// Set STORYBOARD_DRY_RUN=1 to skip Gemini: segments are built from the
// WhisperX sentences with heuristic roles. Free end-to-end testing of the
// flow (needs WhisperX).
export function storyboardDryRun(): boolean {
  return process.env.STORYBOARD_DRY_RUN === "1";
}

const MAX_ANALYSIS_SHOTS = 15;

export function segmentsPath(videoId: string): string {
  return sidecarPath(videoId, "segments");
}

export interface MasterAnalysisResult {
  analysis: GeminiAnalysis;
  shots: GeminiAnalysis["shots"];
  usage: Record<string, unknown> | undefined;
  segments: MasterSegments;
}

// Upload a file to the Gemini Files API and wait until it is ACTIVE.
// Returns the part plus the uploaded name so the caller can delete it.
export async function uploadForGemini(
  ai: GoogleGenAI,
  path: string,
  mimeType: string,
  deadlineMs = 180_000
): Promise<{ part: ReturnType<typeof createPartFromUri>; name: string }> {
  const uploaded = await ai.files.upload({ file: path, config: { mimeType } });
  const name = uploaded.name!;
  let file = uploaded;
  const deadline = Date.now() + deadlineMs;
  while (file.state !== "ACTIVE") {
    if (file.state === "FAILED") throw new Error("Gemini file processing failed");
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for Gemini file to become ACTIVE");
    }
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai.files.get({ name });
  }
  return { part: createPartFromUri(file.uri!, file.mimeType || mimeType), name };
}

function brandIntro(duration: number): string {
  const brand = getBrandConfig();
  return `You are studying a long recording ("master") of ${brand.name}'s own footage —
their product is ${brand.product.description} — to find the pieces worth cutting
into short vertical videos (TikTok). The master is ${duration.toFixed(1)} seconds
long. Someone is usually talking to camera about the product; there may also be
silent product footage.`;
}

const SEGMENT_FIELDS = `For EACH segment:
- text: the segment's words, copied verbatim
- topic: 3-6 word label
- role: "hook" (a scroll-stopping opener: curiosity, tension, a bold claim),
  "claim" (a benefit or promise), "demo" (showing/using the product),
  "proof" (evidence, numbers, a story that backs a claim), "objection"
  (raising and answering a doubt), "cta" (call to action or closing
  payoff), or "filler" (throat-clearing, tangents, repeats)
- hook_score: 0-10, how well the segment works as the FIRST thing a stranger
  hears with no context. Be strict: most segments are 2-5, a real hook is 7+.
- standalone: true if it makes sense with nothing before it
- on_screen_text_idea: max 8 words of on-screen text, or ""

VIDEO-LEVEL fields:
- summary: 2 sentences on what the recording covers
- hook_description: which segment would open the strongest short, and why
- format: one of "pov", "reveal", "transformation", "storytime", "haul",
  "tutorial", "skit", "reaction", "montage", "other"
- tags: 5-10 lowercase tags (product, setting, vibe)
- music_usage: "original_audio_talking" when someone talks; otherwise the
  closest of "background_music", "voiceover_over_music", "sound_effect_driven"
- music_usage_note: one sentence`;

function wordModePrompt(duration: number, transcript: string, wordCount: number): string {
  return `${brandIntro(duration)}

The attached video is the footage. The transcript below was produced by a
word-level aligner and is the ONLY source of timing: refer to words by their
index numbers and NEVER output seconds. Words are numbered 0 to ${wordCount - 1}.

TRANSCRIPT (S = sentence with its word range and time span; each token is
index:word):
${transcript}

Return JSON matching the schema:
- segments: split the ENTIRE transcript, in order, into consecutive
  non-overlapping segments. Each segment is one complete thought: one to
  three sentences, roughly 2-15 seconds of speech. start_word and end_word
  are inclusive indices. The first segment starts at word 0, every next
  segment starts at the previous end_word + 1, and the last segment ends at
  word ${wordCount - 1}. Never split a sentence unless it is longer than 15 s.
${SEGMENT_FIELDS}`;
}

function timeModePrompt(duration: number): string {
  return `${brandIntro(duration)}

Watch and listen to the ENTIRE attached video. Return JSON matching the
schema:
- full_transcript: everything said, verbatim, in order ("" if no speech)
- segments: split the whole recording, in order, into consecutive
  non-overlapping segments of 2-15 seconds. Each is one complete thought
  (one to three sentences) and must end on a sentence boundary. start_time
  and end_time are plain decimal SECONDS from the start (e.g. 12.5 is twelve
  and a half seconds) — NEVER minutes or MM.SS notation. Segments must cover
  the whole ${duration.toFixed(1)} seconds with the first at 0 and the last
  ending at ${duration.toFixed(1)}; silent stretches become "filler".
${SEGMENT_FIELDS}`;
}

async function callGemini<T>(
  ai: GoogleGenAI,
  parts: Array<ReturnType<typeof createPartFromUri> | string>,
  basePrompt: string,
  responseSchema: object,
  parse: (raw: string) => T
): Promise<{ result: T; usage: Record<string, unknown> | undefined }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: Your previous response was rejected (${
            lastError instanceof Error ? lastError.message.slice(0, 300) : "invalid JSON"
          }). Return ONLY valid JSON matching the provided schema.`;
    const response = await ai.models.generateContent({
      model: getGeminiModel(ai),
      contents: createUserContent([...parts, prompt]),
      config: { responseMimeType: "application/json", responseSchema },
    });
    const rawText = response.text ?? "";
    try {
      return {
        result: parse(rawText),
        usage: response.usageMetadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `Master segmentation failed validation (attempt ${attempt + 1}):`,
        error,
        "\nraw:",
        rawText.slice(0, 2000)
      );
    }
  }
  throw new Error(
    `Gemini returned invalid segments after retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

// Word-mode segments: sort, clamp, force contiguity, resolve times
function resolveWordSegments(
  raw: GeminiWordSegments["segments"],
  words: Word[],
  duration: number
): Segment[] {
  const last = words.length - 1;
  const sorted = [...raw]
    .map((s) => ({
      ...s,
      start_word: Math.max(0, Math.min(Math.floor(s.start_word), last)),
      end_word: Math.max(0, Math.min(Math.floor(s.end_word), last)),
    }))
    .sort((a, b) => a.start_word - b.start_word);
  const out: Segment[] = [];
  let cursor = 0;
  for (const s of sorted) {
    const startWord = Math.max(cursor, s.start_word);
    const endWord = Math.max(startWord, s.end_word);
    if (startWord > last) break;
    if (endWord < cursor) continue;
    const { start, end } = rangeToTimes(words, startWord, endWord, duration);
    out.push({
      index: out.length,
      start_time: start,
      end_time: end,
      start_word: startWord,
      end_word: endWord,
      text: wordsToText(words, startWord, endWord),
      topic: s.topic,
      role: s.role,
      hook_score: Math.max(0, Math.min(10, s.hook_score)),
      standalone: s.standalone,
      on_screen_text_idea: s.on_screen_text_idea,
    });
    cursor = endWord + 1;
  }
  // Anything Gemini left off the end becomes a trailing segment
  if (cursor <= last && out.length > 0) {
    const { start, end } = rangeToTimes(words, cursor, last, duration);
    out.push({
      index: out.length,
      start_time: start,
      end_time: end,
      start_word: cursor,
      end_word: last,
      text: wordsToText(words, cursor, last),
      topic: "closing words",
      role: "filler",
      hook_score: 1,
      standalone: false,
      on_screen_text_idea: "",
    });
  }
  if (out.length === 0) throw new Error("No usable segments");
  return out;
}

// Time-mode segments: clamp, order, drop garbage, snap to silences
function resolveTimeSegments(
  raw: GeminiTimeSegments["segments"],
  silences: MasterSegments["silences"],
  duration: number
): Segment[] {
  const tolerance = 0.5;
  const cleaned = raw
    .map((s) => ({
      ...s,
      start_time: s.start_time < 0 && s.start_time > -tolerance ? 0 : s.start_time,
      end_time:
        s.end_time > duration && s.end_time < duration + tolerance
          ? duration
          : s.end_time,
    }))
    .filter(
      (s) =>
        s.start_time >= 0 && s.end_time <= duration && s.end_time > s.start_time
    )
    .sort((a, b) => a.start_time - b.start_time);
  const covered = cleaned.reduce((sum, s) => sum + (s.end_time - s.start_time), 0);
  if (cleaned.length === 0 || covered < duration * 0.6) {
    throw new Error(
      `Segments cover only ${covered.toFixed(1)}s of a ${duration.toFixed(1)}s video — timestamps look wrong (wrong unit?)`
    );
  }
  const out: Segment[] = [];
  for (const s of cleaned) {
    let start = snapToSilence(s.start_time, silences);
    let end = snapToSilence(s.end_time, silences);
    if (out.length > 0 && start < out[out.length - 1].end_time) {
      start = out[out.length - 1].end_time;
    }
    if (end <= start + 0.2) end = Math.min(duration, start + Math.max(0.5, s.end_time - s.start_time));
    if (end <= start) continue;
    out.push({
      index: out.length,
      start_time: Math.round(start * 1000) / 1000,
      end_time: Math.round(end * 1000) / 1000,
      start_word: null,
      end_word: null,
      text: s.text,
      topic: s.topic,
      role: s.role,
      hook_score: Math.max(0, Math.min(10, s.hook_score)),
      standalone: s.standalone,
      on_screen_text_idea: s.on_screen_text_idea,
    });
  }
  return out;
}

// Dry run: every WhisperX sentence is a segment with heuristic roles
function heuristicSegments(words: Word[], sentences: Sentence[], duration: number): Segment[] {
  return sentences.map((s, idx) => {
    const { start, end } = rangeToTimes(words, s.start_word, s.end_word, duration);
    const isFirst = idx === 0;
    const isLast = idx === sentences.length - 1;
    const role = isFirst ? "hook" : isLast ? "cta" : idx % 2 === 0 ? "claim" : "demo";
    return {
      index: idx,
      start_time: start,
      end_time: end,
      start_word: s.start_word,
      end_word: s.end_word,
      text: s.text,
      topic: s.text.split(/\s+/).slice(0, 4).join(" "),
      role,
      hook_score: isFirst ? 7 : isLast ? 3 : 4,
      standalone: isFirst,
      on_screen_text_idea: isFirst ? s.text.split(/\s+/).slice(0, 6).join(" ") : "",
    };
  });
}

// The editor's shot list, derived from the segments: contiguous, capped at
// MAX_ANALYSIS_SHOTS by merging neighbours
export function shotsFromSegments(
  segments: Segment[],
  duration: number
): GeminiAnalysis["shots"] {
  const groupSize = Math.max(1, Math.ceil(segments.length / MAX_ANALYSIS_SHOTS));
  const shots: GeminiAnalysis["shots"] = [];
  for (let i = 0; i < segments.length; i += groupSize) {
    const group = segments.slice(i, i + groupSize);
    const next = segments[i + groupSize];
    const start = shots.length === 0 ? 0 : group[0].start_time;
    const end = next ? next.start_time : duration;
    const roles = Array.from(new Set(group.map((g) => g.role)));
    shots.push({
      start_time: Math.round(start * 1000) / 1000,
      end_time: Math.round(end * 1000) / 1000,
      description: `Speaker on camera: ${group.map((g) => g.topic).join("; ")}`.slice(0, 200),
      on_screen_text: "",
      spoken_text: group.map((g) => g.text).join(" "),
      camera_style: "static",
      time_of_day: "unclear",
      tags: ["talking head", "original footage", ...roles],
    });
  }
  return shots;
}

export async function analyzeMaster(
  ai: GoogleGenAI | null,
  videoPath: string,
  videoId: string,
  meta: MasterProjectMeta,
  duration: number
): Promise<MasterAnalysisResult> {
  const dryRun = storyboardDryRun();
  const choice = await resolveTimingEngine(meta.timingEngine ?? null);
  let engine: TimingSource = choice.engine;
  let timingNote: string | null = choice.note;

  const silences = await detectSilences(videoPath).catch((error) => {
    console.error("silencedetect failed:", error);
    return [] as MasterSegments["silences"];
  });

  // 1. Timing
  let words: Word[] = [];
  let sentences: Sentence[] = [];
  let transcript = "";
  let whisperx: MasterSegments["whisperx"] = null;
  if (engine === "whisperx") {
    try {
      const result = await transcribeWithWhisperX(videoPath);
      words = result.words;
      sentences = result.sentences;
      transcript = result.transcript;
      whisperx = {
        model: result.model,
        version: result.version,
        durationMs: result.durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("WhisperX failed, falling back to Gemini timing:", error);
      engine = "gemini";
      timingNote = `WhisperX failed (${message.split("\n")[0].slice(0, 200)}). Used Gemini timing (approximate).`;
    }
  }

  if (dryRun && engine !== "whisperx") {
    throw new Error(
      "STORYBOARD_DRY_RUN needs WhisperX timing — install WhisperX or unset the dry run"
    );
  }
  if (!dryRun && !ai) {
    throw new Error("Gemini is not configured");
  }

  // 2. Understanding
  let segments: Segment[];
  let video: Omit<GeminiAnalysis, "shots" | "full_transcript">;
  let usage: Record<string, unknown> | undefined;

  if (dryRun) {
    segments = heuristicSegments(words, sentences, duration);
    video = {
      summary: `Dry run: ${sentences.length} sentences from WhisperX, no Gemini call.`,
      hook_description: sentences[0]?.text ?? "",
      format: "storytime",
      tags: ["dry run", "talking head"],
      music_usage: "original_audio_talking",
      music_usage_note: "Speaker's own audio",
    };
  } else {
    let uploadedName: string | undefined;
    try {
      const { part, name } = await uploadForGemini(ai!, videoPath, "video/mp4");
      uploadedName = name;
      if (engine === "whisperx") {
        const numbered = formatNumberedTranscript(words, sentences);
        const { result, usage: u } = await callGemini(
          ai!,
          [part],
          wordModePrompt(duration, numbered, words.length),
          geminiWordSegmentsResponseSchema,
          (raw) => GeminiWordSegmentsZ.parse(JSON.parse(raw))
        );
        usage = u;
        segments = resolveWordSegments(result.segments, words, duration);
        video = {
          summary: result.summary,
          hook_description: result.hook_description,
          format: result.format,
          tags: result.tags,
          music_usage: result.music_usage,
          music_usage_note: result.music_usage_note,
        };
      } else {
        const { result, usage: u } = await callGemini(
          ai!,
          [part],
          timeModePrompt(duration),
          geminiTimeSegmentsResponseSchema,
          (raw) => GeminiTimeSegmentsZ.parse(JSON.parse(raw))
        );
        usage = u;
        segments = resolveTimeSegments(result.segments, silences, duration);
        transcript = result.full_transcript;
        video = {
          summary: result.summary,
          hook_description: result.hook_description,
          format: result.format,
          tags: result.tags,
          music_usage: result.music_usage,
          music_usage_note: result.music_usage_note,
        };
      }
    } finally {
      if (uploadedName) {
        try {
          await ai!.files.delete({ name: uploadedName });
        } catch (cleanupError) {
          console.error("Failed to delete Gemini file:", cleanupError);
        }
      }
    }
  }

  const shots = shotsFromSegments(segments, duration);
  const stored: MasterSegments = MasterSegmentsZ.parse({
    videoId,
    analyzedAt: new Date().toISOString(),
    model: dryRun ? "dry-run" : getGeminiModel(ai),
    timing_source: engine,
    whisperx,
    words,
    sentences,
    silences,
    full_transcript: transcript,
    segments,
    timing_note: timingNote,
    usage: usage
      ? {
          promptTokens: (usage.promptTokenCount as number) ?? undefined,
          outputTokens: (usage.candidatesTokenCount as number) ?? undefined,
          totalTokens: (usage.totalTokenCount as number) ?? undefined,
        }
      : undefined,
  });
  const path = segmentsPath(videoId);
  await fs.writeFile(`${path}.tmp`, JSON.stringify(stored, null, 2));
  await fs.rename(`${path}.tmp`, path);

  return {
    analysis: { ...video, full_transcript: transcript, shots },
    shots,
    usage,
    segments: stored,
  };
}

export async function readMasterSegments(videoId: string): Promise<MasterSegments | null> {
  try {
    return MasterSegmentsZ.parse(JSON.parse(await fs.readFile(segmentsPath(videoId), "utf8")));
  } catch {
    return null;
  }
}

export async function analyzeAndStoreMaster(
  ai: GoogleGenAI | null,
  videoPath: string,
  videoId: string,
  project: MasterProjectMeta,
  duration: number
): Promise<Analysis> {
  await assertAnalysisReplaceable(videoId);
  await fs.mkdir(ANALYSIS_DIR, { recursive: true });
  const { analysis, shots, segments } = await analyzeMaster(ai, videoPath, videoId, project, duration);
  await extractScreenshots(videoPath, videoId, shots, duration);
  const stored: Analysis = {
    videoId,
    analyzedAt: segments.analyzedAt,
    model: segments.model,
    summary: analysis.summary,
    hook_description: analysis.hook_description,
    format: analysis.format,
    tags: analysis.tags,
    music: { title: "", author: "", usage: analysis.music_usage, usage_note: analysis.music_usage_note },
    full_transcript: analysis.full_transcript,
    shots: shots.map((shot, index) => ({ ...shot, id: `${videoId}:${segments.analyzedAt}:${index}`, index, screenshot: `/api/analysis-shot/${videoId}/${index}` })),
    usage: segments.usage,
  };
  const path = analysisPath(videoId);
  await fs.writeFile(`${path}.tmp`, JSON.stringify(stored, null, 2));
  await fs.rename(`${path}.tmp`, path);
  return stored;
}
