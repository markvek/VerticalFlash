import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join, basename, extname } from "path";
import { tmpdir } from "os";
import { execFileAsync } from "./ffmpeg";
import { detectWhisperX, whisperXModel, WhisperXMissingError } from "./whisperx";
import type { Sentence, Word } from "./segments-schema";

// Run WhisperX on a video and return every word with its start/end. The
// audio is extracted to 16 kHz mono WAV first (what the aligner expects),
// and the CLI writes one JSON file per input into --output_dir.

const rawExecFileAsync = promisify(execFile);

// Whole-file transcription of a long master on CPU can take a while
const WHISPERX_TIMEOUT_MS = 30 * 60_000;
const WHISPERX_MAX_BUFFER = 64 * 1024 * 1024;

export interface WhisperXResult {
  words: Word[];
  sentences: Sentence[];
  transcript: string;
  language: string | null;
  model: string;
  version: string;
  durationMs: number;
}

interface RawWord {
  word: string;
  start?: number;
  end?: number;
  score?: number;
}

interface RawSegment {
  start: number;
  end: number;
  text: string;
  words?: RawWord[];
}

interface RawOutput {
  segments: RawSegment[];
  word_segments?: RawWord[];
  language?: string;
}

async function extractWav(videoPath: string, wavPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]);
}

// Words WhisperX could not align come back without times. Spread each run
// of untimed words evenly across the gap between its timed neighbours
// (or the sentence's bounds at either edge) so every word has a usable
// window, and flag them so cuts prefer timed neighbours.
function fillMissingTimes(
  words: Array<{ word: string; start: number | null; end: number | null; score: number | null }>,
  sentenceStart: number,
  sentenceEnd: number
): Array<{ word: string; start: number; end: number; score: number | null; interpolated: boolean }> {
  const out = words.map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    score: w.score,
    interpolated: w.start == null || w.end == null,
  }));
  let i = 0;
  while (i < out.length) {
    if (!out[i].interpolated) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j].interpolated) j++;
    const gapStart = i > 0 ? (out[i - 1].end as number) : sentenceStart;
    const gapEnd = j < out.length ? (out[j].start as number) : sentenceEnd;
    const span = Math.max(0, gapEnd - gapStart);
    const n = j - i;
    for (let k = 0; k < n; k++) {
      out[i + k].start = gapStart + (span * k) / n;
      out[i + k].end = gapStart + (span * (k + 1)) / n;
    }
    i = j;
  }
  return out as Array<{ word: string; start: number; end: number; score: number | null; interpolated: boolean }>;
}

export function parseWhisperXOutput(raw: RawOutput): {
  words: Word[];
  sentences: Sentence[];
  transcript: string;
} {
  const words: Word[] = [];
  const sentences: Sentence[] = [];
  for (const seg of raw.segments ?? []) {
    const rawWords = (seg.words ?? []).filter((w) => w.word?.trim());
    if (rawWords.length === 0) continue;
    const filled = fillMissingTimes(
      rawWords.map((w) => ({
        word: w.word.trim(),
        start: typeof w.start === "number" ? w.start : null,
        end: typeof w.end === "number" ? w.end : null,
        score: typeof w.score === "number" ? w.score : null,
      })),
      seg.start,
      seg.end
    );
    const startWord = words.length;
    for (const w of filled) {
      words.push({
        i: words.length,
        word: w.word,
        start: Math.round(w.start * 1000) / 1000,
        end: Math.round(Math.max(w.end, w.start) * 1000) / 1000,
        score: w.score,
        interpolated: w.interpolated,
      });
    }
    sentences.push({
      start: Math.round(seg.start * 1000) / 1000,
      end: Math.round(seg.end * 1000) / 1000,
      text: seg.text.trim(),
      start_word: startWord,
      end_word: words.length - 1,
    });
  }
  // Timestamps must never run backwards across sentence joins
  for (let k = 1; k < words.length; k++) {
    if (words[k].start < words[k - 1].end) {
      words[k].start = words[k - 1].end;
      if (words[k].end < words[k].start) words[k].end = words[k].start;
    }
  }
  const transcript = sentences.map((s) => s.text).join(" ");
  return { words, sentences, transcript };
}

export async function transcribeWithWhisperX(
  videoPath: string,
  opts?: { model?: string; language?: string | null }
): Promise<WhisperXResult> {
  const detection = await detectWhisperX();
  if (!detection.available || !detection.binary) {
    throw new WhisperXMissingError(detection.reason ?? undefined);
  }
  const model = opts?.model ?? whisperXModel();
  const language =
    opts?.language === undefined
      ? process.env.WHISPERX_LANGUAGE?.trim() || null
      : opts.language;

  const workDir = await fs.mkdtemp(join(tmpdir(), "whisperx-"));
  const stem = basename(videoPath, extname(videoPath)).replace(/[^\w.-]+/g, "_") || "audio";
  const wavPath = join(workDir, `${stem}.wav`);
  const started = Date.now();
  try {
    await extractWav(videoPath, wavPath);

    const args = [
      wavPath,
      "--model",
      model,
      "--compute_type",
      process.env.WHISPERX_COMPUTE_TYPE?.trim() || "int8",
      "--device",
      process.env.WHISPERX_DEVICE?.trim() || "cpu",
      "--batch_size",
      process.env.WHISPERX_BATCH_SIZE?.trim() || "8",
      "--output_format",
      "json",
      "--output_dir",
      workDir,
      "--print_progress",
      "False",
    ];
    if (language) args.push("--language", language);

    try {
      await rawExecFileAsync(detection.binary, args, {
        timeout: WHISPERX_TIMEOUT_MS,
        maxBuffer: WHISPERX_MAX_BUFFER,
        env: { ...process.env, PYTHONWARNINGS: "ignore" },
      });
    } catch (error) {
      const stderr = (error as { stderr?: string })?.stderr ?? "";
      throw new Error(
        `whisperx failed: ${
          error instanceof Error ? error.message.split("\n")[0] : String(error)
        }${stderr ? `\n${stderr.trim().split("\n").slice(-8).join("\n")}` : ""}`
      );
    }

    const outPath = join(workDir, `${stem}.json`);
    const raw = JSON.parse(await fs.readFile(outPath, "utf8")) as RawOutput;
    const { words, sentences, transcript } = parseWhisperXOutput(raw);
    if (words.length === 0) {
      throw new Error("whisperx produced no words (silent audio?)");
    }
    return {
      words,
      sentences,
      transcript,
      language: raw.language ?? language,
      model,
      version: detection.version ?? "unknown",
      durationMs: Date.now() - started,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
