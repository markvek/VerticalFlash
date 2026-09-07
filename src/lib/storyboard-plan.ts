import { createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { GEMINI_MODEL } from "./gemini";
import { getBrandConfig } from "./config";
import type { CatalogSummary } from "./shot-plan";
import {
  GeminiTimeStoryboardsZ,
  GeminiWordStoryboardsZ,
  MasterStoryboardsZ,
  PACING_BOUNDS,
  geminiTimeStoryboardsResponseSchema,
  geminiWordStoryboardsResponseSchema,
  type Beat,
  type MasterSegments,
  type MasterStoryboards,
  type Segment,
  type Storyboard,
  type StoryboardRequest,
} from "./segments-schema";
import { STORYBOARD_SECTIONS, type StoryboardSection } from "./project-kinds";
import { sidecarPath } from "./paths";
import { rangeToTimes, snapToSilence, wordsToText } from "./word-timing";
import { storyboardDryRun } from "./master-analyze";

// Storyboards for a master: hook → main → end beat lists cut from the
// segments, one per requested idea. Text-only Gemini call; beats come back
// as word ranges (WhisperX timing) or segment-boundary seconds (Gemini
// timing) and are resolved to cut times here.

export function storyboardsPath(videoId: string): string {
  return sidecarPath(videoId, "storyboards");
}

export { readStoryboards, writeStoryboards } from "./storyboard-store";

// One target length per idea: a single entry applies to every idea
export function lengthsFor(request: StoryboardRequest): number[] {
  if (request.lengths.length === 1) {
    return Array.from({ length: request.count }, () => request.lengths[0]);
  }
  if (request.lengths.length !== request.count) {
    throw new Error(
      `lengths must have 1 entry or exactly ${request.count} (one per idea)`
    );
  }
  return request.lengths;
}

function segmentsForPrompt(segments: Segment[], wordMode: boolean) {
  return segments.map((s) => ({
    index: s.index,
    source: s.source?.filename ?? "original recording",
    ...(wordMode
      ? { start_word: s.start_word, end_word: s.end_word }
      : {}),
    start_time: Math.round(s.start_time * 10) / 10,
    end_time: Math.round(s.end_time * 10) / 10,
    seconds: Math.round((s.end_time - s.start_time) * 10) / 10,
    role: s.role,
    hook_score: s.hook_score,
    standalone: s.standalone,
    topic: s.topic,
    text: s.text,
  }));
}

function buildPrompt(
  segments: MasterSegments,
  request: StoryboardRequest,
  lengths: number[],
  catalog: CatalogSummary[] | null
): string {
  const brand = getBrandConfig();
  const wordMode = segments.timing_source === "whisperx" && segments.segments.every((segment) => segment.start_word != null && segment.end_word != null);
  const bounds = PACING_BOUNDS[request.pacing];
  const ideaLines = lengths
    .map((len, i) => `- Storyboard ${i + 1}: target ${len} seconds (±10%)`)
    .join("\n");
  const timingRule = wordMode
    ? `Beats reference the transcript by WORD INDEX: start_word and end_word are
inclusive indices from the segment list below. A beat may be a whole
segment, several consecutive segments, or part of a segment — but it must
start at a segment's start_word or right after a sentence-ending word, and
end at a segment's end_word or on a sentence-ending word (a word ending in
. ! or ?). Never start or end mid-sentence. Estimate a beat's seconds from
the segment times listed.`
    : `Beats reference the segment list by TIME: start_time must equal some
segment's start_time and end_time must equal some segment's end_time
(plain decimal seconds, copied exactly). A beat may span several
consecutive segments. Never invent times.`;
  const brollRule = request.allow_broll
    ? `B-roll IS allowed: on "main" beats where cutaway footage would help, set
show="broll" with a concrete broll_description (what we see) and 3-6
broll_tags reusing the library vocabulary. Keep the hook and the end on
show="source". The library (what exists): ${JSON.stringify(catalog ?? [], null, 0)}`
    : `B-roll is NOT allowed: set show="source", broll_description="" and
broll_tags=[] on every beat.`;

  return `You are cutting short vertical videos (TikTok) from a long recording of
"${brand.name}" — their product is ${brand.product.description}. The recording
has been transcribed and split into timed segments with a role and a
hook_score (0-10, how well the segment opens a video for a stranger).

Build exactly ${request.count} DIFFERENT storyboards:
${ideaLines}

Each storyboard is a list of beats in PLAYBACK order. Structure:
1. One or more "hook" beats first: the opener. Pick the strongest standalone
   moment for THIS storyboard's angle (hook_score matters, but a claim,
   objection or proof can also open a video). Keep the hook to at most
   ~3 seconds of speech or one punchy sentence.
2. "main" beats: the body. You may reorder segments from the master so the
   short tells one clear story; it does not have to follow the master's
   order. Do not repeat words already used in the hook.
3. Exactly one "end" beat last: a payoff, a punchline, or the call to action.

Rules:
- The beats' total seconds must land within ±10% of the storyboard's target.
- Pacing "${request.pacing}": each beat lasts ${bounds.min}-${bounds.max} seconds
  (a longer thought can be split across consecutive beats).
- The ${request.count} storyboards must differ in their hook or angle, not
  just in trimming. Say what the angle is.
- Skip "filler" segments unless nothing else fits.
- Never span two different sources in one beat. Times use the combined source timeline.
- ${timingRule}
- ${brollRule}
- on_screen_text: for the hook beat, punchy text of at most 8 words; for
  other beats, at most 8 words or "".
- hook_line: the first spoken words of the storyboard, verbatim.
- title: 3-6 words. angle: one sentence on why this cut should hold viewers.
- target_seconds: copy the storyboard's target from the list above.
${request.brief.trim() ? `\nBRIEF FROM THE USER (steer the choice of segments and angles): ${request.brief.trim()}\n` : ""}
SEGMENTS (${segments.segments.length}, in master order):
${JSON.stringify(segmentsForPrompt(segments.segments, wordMode), null, 0)}`;
}

function sectionOf(value: string): StoryboardSection {
  return (STORYBOARD_SECTIONS as readonly string[]).includes(value)
    ? (value as StoryboardSection)
    : "main";
}

function nearest(values: number[], target: number, maxShift: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const v of values) {
    const d = Math.abs(v - target);
    if (d <= maxShift && d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

interface RawBeatCommon {
  section: string;
  on_screen_text: string;
  show: "source" | "broll";
  broll_description: string;
  broll_tags: string[];
}

function finishBeat(
  raw: RawBeatCommon,
  start: number,
  end: number,
  startWord: number | null,
  endWord: number | null,
  text: string,
  allowBroll: boolean
): Beat {
  const section = sectionOf(raw.section);
  const show: Beat["show"] =
    allowBroll && raw.show === "broll" && section === "main" ? "broll" : "source";
  return {
    section,
    start: Math.round(start * 1000) / 1000,
    end: Math.round(end * 1000) / 1000,
    start_word: startWord,
    end_word: endWord,
    text,
    on_screen_text: raw.on_screen_text.trim().split(/\s+/).slice(0, 10).join(" "),
    show,
    broll_hint:
      show === "broll"
        ? {
            description: raw.broll_description,
            tags: raw.broll_tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
          }
        : null,
  };
}

// Section sanity: first beat is the hook, last beat is the end, everything
// between is main
function normalizeSections(beats: Beat[]): Beat[] {
  if (beats.length === 0) return beats;
  return beats.map((b, i) => ({
    ...b,
    section: i === 0 ? "hook" : i === beats.length - 1 ? "end" : "main",
    show: i === 0 || i === beats.length - 1 ? "source" : b.show,
    broll_hint: i === 0 || i === beats.length - 1 ? null : b.broll_hint,
  }));
}

export function normalizeEditableStoryboard(storyboard: Storyboard): Storyboard {
  const beats = normalizeSections(storyboard.beats).map((beat) => ({
    ...beat,
    start: Math.round(beat.start * 1000) / 1000,
    end: Math.round(beat.end * 1000) / 1000,
  }));
  const estimated = beats.reduce((sum, beat) => sum + (beat.end - beat.start), 0);
  const hookBeat = beats[0];
  return {
    ...storyboard,
    hook_line:
      hookBeat?.text.trim().split(/\s+/).slice(0, 16).join(" ") ||
      storyboard.hook_line,
    estimated_seconds: Math.round(estimated * 10) / 10,
    beats,
  };
}

function makeStoryboard(
  k: number,
  raw: { title: string; hook_line: string; angle: string; target_seconds: number },
  beats: Beat[],
  targetSeconds: number
): Storyboard {
  const normalized = normalizeSections(beats);
  const estimated = normalized.reduce((s, b) => s + (b.end - b.start), 0);
  return {
    id: `sb${k + 1}-${Date.now().toString(36)}`,
    title: raw.title,
    hook_line: raw.hook_line || normalized[0]?.text.split(/\s+/).slice(0, 12).join(" ") || "",
    angle: raw.angle,
    target_seconds: targetSeconds,
    estimated_seconds: Math.round(estimated * 10) / 10,
    beats: normalized,
  };
}

// Dry run: hook = k-th best hook_score standalone segment, then the
// following segments in order until the target is met, then the last
// cta/segment as the end
function heuristicStoryboards(
  segments: MasterSegments,
  request: StoryboardRequest,
  lengths: number[]
): Storyboard[] {
  const segs = segments.segments;
  const byHook = [...segs]
    .filter((s) => s.role !== "filler")
    .sort((a, b) => b.hook_score - a.hook_score || a.index - b.index);
  const endSeg =
    [...segs].reverse().find((s) => s.role === "cta") ?? segs[segs.length - 1];
  return lengths.map((target, k) => {
    const hook = byHook[k % byHook.length] ?? segs[0];
    const beats: Beat[] = [];
    const toBeat = (s: Segment, section: StoryboardSection): Beat => ({
      section,
      start: s.start_time,
      end: s.end_time,
      start_word: s.start_word,
      end_word: s.end_word,
      text: s.text,
      on_screen_text: section === "hook" ? s.on_screen_text_idea : "",
      show: "source",
      broll_hint: null,
      source: s.source,
      thumbnail: s.thumbnail,
    });
    beats.push(toBeat(hook, "hook"));
    let total = hook.end_time - hook.start_time;
    const endLen = endSeg.end_time - endSeg.start_time;
    for (const s of segs) {
      if (s.index === hook.index || s.index === endSeg.index) continue;
      if (s.role === "filler") continue;
      const len = s.end_time - s.start_time;
      if (total + len + endLen > target * 1.1) continue;
      beats.push(toBeat(s, "main"));
      total += len;
      if (total + endLen >= target * 0.9) break;
    }
    if (endSeg.index !== hook.index) beats.push(toBeat(endSeg, "end"));
    return makeStoryboard(
      k,
      {
        title: `Dry run idea ${k + 1}`,
        hook_line: hook.text,
        angle: `Opens on segment ${hook.index + 1} (hook score ${hook.hook_score}).`,
        target_seconds: target,
      },
      beats,
      target
    );
  });
}

export async function generateStoryboards(
  ai: GoogleGenAI | null,
  segments: MasterSegments,
  request: StoryboardRequest,
  duration: number,
  catalog: CatalogSummary[] | null
): Promise<MasterStoryboards> {
  const lengths = lengthsFor(request);
  const dryRun = storyboardDryRun();
  const wordMode = segments.timing_source === "whisperx" && segments.segments.every((segment) => segment.start_word != null && segment.end_word != null);

  let storyboards: Storyboard[];
  let usage: Record<string, unknown> | undefined;

  if (dryRun) {
    storyboards = heuristicStoryboards(segments, request, lengths);
  } else {
    if (!ai) throw new Error("Gemini is not configured");
    const basePrompt = buildPrompt(segments, request, lengths, catalog);
    let lastError: unknown;
    let parsed:
      | { mode: "word"; data: ReturnType<typeof GeminiWordStoryboardsZ.parse> }
      | { mode: "time"; data: ReturnType<typeof GeminiTimeStoryboardsZ.parse> }
      | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const prompt =
        attempt === 0
          ? basePrompt
          : `${basePrompt}\n\nIMPORTANT: Your previous response was rejected (${
              lastError instanceof Error ? lastError.message.slice(0, 300) : "invalid JSON"
            }). Return ONLY valid JSON matching the provided schema.`;
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: createUserContent([prompt]),
        config: {
          responseMimeType: "application/json",
          responseSchema: wordMode
            ? geminiWordStoryboardsResponseSchema
            : geminiTimeStoryboardsResponseSchema,
        },
      });
      const rawText = response.text ?? "";
      try {
        parsed = wordMode
          ? { mode: "word", data: GeminiWordStoryboardsZ.parse(JSON.parse(rawText)) }
          : { mode: "time", data: GeminiTimeStoryboardsZ.parse(JSON.parse(rawText)) };
        usage = response.usageMetadata as Record<string, unknown> | undefined;
      } catch (error) {
        lastError = error;
        console.error(
          `Storyboard response failed validation (attempt ${attempt + 1}):`,
          error,
          "\nraw:",
          rawText.slice(0, 2000)
        );
      }
    }
    if (!parsed) {
      throw new Error(
        `Gemini returned invalid storyboards after retry: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`
      );
    }

    const segStarts = segments.segments.map((s) => s.start_time);
    const segEnds = segments.segments.map((s) => s.end_time);
    storyboards = [];
    const rawList = parsed.data.storyboards.slice(0, request.count);
    rawList.forEach((sb, k) => {
      const target = lengths[k] ?? lengths[lengths.length - 1];
      const beats: Beat[] = [];
      for (const b of sb.beats) {
        if ("start_word" in b) {
          if (segments.words.length === 0) continue;
          const { start, end } = rangeToTimes(
            segments.words,
            b.start_word,
            b.end_word,
            duration
          );
          if (end <= start) continue;
          beats.push(
            finishBeat(
              b,
              start,
              end,
              Math.max(0, Math.min(b.start_word, segments.words.length - 1)),
              Math.max(0, Math.min(b.end_word, segments.words.length - 1)),
              wordsToText(segments.words, b.start_word, b.end_word),
              request.allow_broll
            )
          );
        } else {
          // Snap to the segment boundaries Gemini was told to copy, then to
          // a silence as a second chance; anything else is dropped
          const start =
            nearest(segStarts, b.start_time, 1.0) ??
            snapToSilence(b.start_time, segments.silences);
          const end =
            nearest(segEnds, b.end_time, 1.0) ??
            snapToSilence(b.end_time, segments.silences);
          if (!(end > start) || start < 0 || end > duration + 0.05) continue;
          const text = segments.segments
            .filter((s) => s.start_time >= start - 0.05 && s.end_time <= end + 0.05)
            .map((s) => s.text)
            .join(" ");
          beats.push(finishBeat(b, start, Math.min(end, duration), null, null, text, request.allow_broll));
        }
      }
      if (beats.length === 0) return;
      storyboards.push(makeStoryboard(k, sb, beats, target));
    });
    if (storyboards.length === 0) {
      throw new Error("Gemini returned storyboards with no usable beats");
    }
  }

  // Source boundaries in the virtual transcript must remain real clip cuts.
  storyboards = storyboards.map((storyboard) => ({
    ...storyboard,
    beats: storyboard.beats.flatMap((beat) => {
      const first = segments.segments.find((segment) => beat.start < segment.end_time && beat.end > segment.start_time);
      const last = [...segments.segments].reverse().find((segment) => beat.end > segment.start_time && beat.start < segment.end_time);
      if (!first || !last || first.source?.filename !== last.source?.filename || first.source?.offset !== last.source?.offset) return [];
      return [{ ...beat, source: first.source, thumbnail: first.thumbnail }];
    }),
  })).filter((storyboard) => storyboard.beats.length > 0).map(normalizeEditableStoryboard);
  if (!storyboards.length) throw new Error("No storyboard beats fit the available footage");

  return MasterStoryboardsZ.parse({
    videoId: segments.videoId,
    generatedAt: new Date().toISOString(),
    model: dryRun ? "dry-run" : GEMINI_MODEL,
    timing_source: segments.timing_source,
    request,
    storyboards,
    accepted: {},
    usage: usage
      ? {
          promptTokens: (usage.promptTokenCount as number) ?? undefined,
          outputTokens: (usage.candidatesTokenCount as number) ?? undefined,
          totalTokens: (usage.totalTokenCount as number) ?? undefined,
        }
      : undefined,
  });
}
