import { execFileAsync } from "./ffmpeg";
import type { Silence, Word } from "./segments-schema";

// Turning "which words" into "which seconds" for the storyboard flow, plus
// the silence-based tightening used when only approximate (Gemini)
// timestamps exist.

// Word-range → seconds helpers live in word-range.ts (pure, shared with the
// client); re-exported here so existing server imports keep working
export {
  LEAD_SECONDS,
  TAIL_SECONDS,
  clampWordRange,
  rangeToTimes,
  wordsToText,
} from "./word-range";

// Snap window for approximate timestamps
export const SNAP_MAX_SHIFT = 0.6;

// Move an approximate boundary into the nearest silence within the snap
// window (to its middle), or leave it alone if it already sits in one or
// no silence is close enough.
export function snapToSilence(
  t: number,
  silences: Silence[],
  maxShift = SNAP_MAX_SHIFT
): number {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const s of silences) {
    if (t >= s.start && t <= s.end) return t;
    const mid = (s.start + s.end) / 2;
    const dist = t < s.start ? s.start - t : t - s.end;
    if (dist <= maxShift && dist < bestDist) {
      bestDist = dist;
      best = mid;
    }
  }
  return best == null ? t : Math.round(best * 1000) / 1000;
}

// ffmpeg silencedetect over the whole file. Thresholds suit a person
// talking to camera: anything under -30 dB for at least 250 ms is a gap.
export async function detectSilences(
  videoPath: string,
  opts?: { noiseDb?: number; minSeconds?: number }
): Promise<Silence[]> {
  const noise = opts?.noiseDb ?? -30;
  const minSeconds = opts?.minSeconds ?? 0.25;
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      videoPath,
      "-vn",
      "-af",
      `silencedetect=noise=${noise}dB:d=${minSeconds}`,
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  const silences: Silence[] = [];
  let open: number | null = null;
  for (const line of String(stderr).split("\n")) {
    const s = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (s) {
      open = parseFloat(s[1]);
      continue;
    }
    const e = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (e && open != null) {
      silences.push({
        start: Math.max(0, Math.round(open * 1000) / 1000),
        end: Math.round(parseFloat(e[1]) * 1000) / 1000,
      });
      open = null;
    }
  }
  return silences;
}

// The transcript as Gemini sees it in WhisperX mode: one line per sentence
// with its word range, then the words numbered so any boundary can be
// named exactly.
export function formatNumberedTranscript(
  words: Word[],
  sentences: Array<{ start_word: number; end_word: number; text: string; start: number; end: number }>
): string {
  const lines: string[] = [];
  sentences.forEach((s, idx) => {
    const numbered = words
      .slice(s.start_word, s.end_word + 1)
      .map((w) => `${w.i}:${w.word}`)
      .join(" ");
    lines.push(
      `S${idx + 1} [words ${s.start_word}-${s.end_word}, ${s.start.toFixed(1)}s-${s.end.toFixed(1)}s]\n${numbered}`
    );
  });
  return lines.join("\n");
}
