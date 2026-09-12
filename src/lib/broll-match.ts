import { clipDescription, clipTags } from "./library-schema";
import { randomUUID } from "crypto";
import { createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { getBrandConfig } from "./config";
import { GEMINI_MODEL } from "./gemini";
import { loadLibrary } from "./library-store";
import { generateTrimWindows, type TrimTarget } from "./trim-windows";
import type { Analysis } from "./analysis-schema";
import type { Word } from "./segments-schema";
import {
  GeminiBrollMatchesZ,
  GeminiBrollMomentsOffsetZ,
  GeminiBrollMomentsZ,
  geminiBrollMatchesResponseSchema,
  geminiBrollMomentsOffsetResponseSchema,
  geminiBrollMomentsResponseSchema,
  type BrollCandidate,
  type BrollSegment,
} from "./broll-schema";
import { MIN_BROLL_SECONDS, phraseForAnchor, wordsForShot, type ResolvedBroll } from "./broll-resolve";

// Gemini stages for the B-roll track: find moments worth covering, match
// library clips to a segment's phrase, and pick the start moment inside a
// clip. Text calls only, except the moment pick (one clip upload each).

export interface CatalogClip {
  filename: string;
  duration: number | null;
  category: string;
  camera_action: string;
  location: string;
  time_of_day: string;
  product_present: boolean;
  description: string;
  tags: string[];
}

// Only clips that have been through Gemini analysis are matchable
export async function loadBrollCatalog(): Promise<CatalogClip[]> {
  const library = await loadLibrary();
  return library.videos
    .filter((v) => v.analysis)
    .map((v) => ({
      filename: v.filename,
      duration: v.duration ?? null,
      category: v.analysis!.category,
      camera_action: v.analysis!.camera_action,
      location: v.analysis!.location,
      time_of_day: v.analysis!.time_of_day,
      product_present: v.analysis!.product_present,
      description: clipDescription(v),
      tags: clipTags(v),
    }));
}

async function callJson<T>(
  ai: GoogleGenAI,
  prompt: string,
  schema: object,
  parse: (raw: unknown) => T
): Promise<{ result: T; usage: Record<string, unknown> | undefined }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text =
      attempt === 0
        ? prompt
        : `${prompt}\n\nIMPORTANT: Your previous response was rejected (${
            lastError instanceof Error ? lastError.message : "invalid JSON"
          }). Return ONLY valid JSON matching the provided schema.`;
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([text]),
      config: { responseMimeType: "application/json", responseSchema: schema },
    });
    const raw = response.text ?? "";
    try {
      return { result: parse(JSON.parse(raw)), usage: response.usageMetadata as Record<string, unknown> | undefined };
    } catch (error) {
      lastError = error;
      console.error(`B-roll Gemini response failed validation (attempt ${attempt + 1}):`, error, "\nraw:", raw.slice(0, 1500));
    }
  }
  throw new Error(
    `Gemini returned an invalid response after retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

// ---- Matching: clips for a segment's phrase -----------------------------

export interface MatchTarget {
  segment: BrollSegment;
  resolved: ResolvedBroll;
}

export async function matchBrollSegments(
  ai: GoogleGenAI,
  analysis: Analysis,
  targets: MatchTarget[],
  catalog: CatalogClip[]
): Promise<Map<string, BrollCandidate[]>> {
  const out = new Map<string, BrollCandidate[]>();
  if (targets.length === 0 || catalog.length === 0) return out;
  const numbered = targets.map((t, n) => {
    const covered = analysis.shots.filter(s => s.start_time < t.resolved.end && s.end_time > t.resolved.start);
    const shot = covered[0];
    return {
      segment: n,
      phrase: t.segment.phrase || "(no speech under this segment)",
      wants: t.segment.description ?? undefined,
      duration_s: Math.round((t.resolved.end - t.resolved.start) * 10) / 10,
      shot_context: covered.map(s => s.description).join("; "),
      shot_lighting: shot?.time_of_day,
    };
  });
  const clips = catalog.map((c) => ({
    filename: c.filename,
    duration_s: c.duration ?? undefined,
    category: c.category,
    camera_action: c.camera_action,
    location: c.location,
    time_of_day: c.time_of_day,
    product_present: c.product_present,
    description: c.description,
    tags: c.tags,
  }));
  const brand = getBrandConfig();
  const prompt = `You are picking B-roll for a short talking-head video. The speaker
stays audible; each segment below is a PHRASE they say that will be covered
by a library clip while they say it. The video is a "${analysis.format}"
format: ${analysis.summary}

The library belongs to the "${brand.name}" brand (${brand.product.description}).

For EVERY segment in list A, recommend clips from list B that visually
illustrate the phrase (and the "wants" note when present). Judge on:
1. WHAT IS SHOWN — the clip's subject and action should make the phrase
   concrete (product close-up for a product claim, the screen for a
   software step, hands for "upload", results for "publish").
2. Duration — the clip should run at least the segment's duration_s
   (longer is fine, it will be trimmed).
3. Lighting consistency with shot_lighting when known
   (indoor_lighting/unclear clips fit anywhere).

Rules:
- 0-3 clips per segment, best first. An empty list is CORRECT when nothing
  illustrates the phrase — do not force weak matches.
- confidence: "strong" (clearly illustrates it), "moderate" (works with
  a stretch), "weak" (plausible fallback).
- reason: ONE short sentence naming what in the clip matches the phrase.
- filename must be copied EXACTLY from list B.
- Include every segment number from list A exactly once.

A. SEGMENTS:
${JSON.stringify(numbered, null, 1)}

B. FOOTAGE LIBRARY:
${JSON.stringify(clips, null, 1)}`;

  const { result } = await callJson(ai, prompt, geminiBrollMatchesResponseSchema, (raw) => GeminiBrollMatchesZ.parse(raw));
  const catalogByName = new Map(catalog.map((c) => [c.filename, c]));
  for (const m of result.matches) {
    const target = targets[m.segment];
    if (!target) continue;
    const seen = new Set<string>();
    const candidates: BrollCandidate[] = [];
    for (const r of m.recommendations) {
      const clip = catalogByName.get(r.filename);
      if (!clip || seen.has(r.filename)) continue;
      seen.add(r.filename);
      candidates.push({
        filename: r.filename,
        duration: clip.duration,
        confidence: r.confidence,
        reason: r.reason,
        clip_start: null,
        moment_note: null,
      });
    }
    out.set(target.segment.id, candidates.slice(0, 3));
  }

  // Trim stage: one upload per clip, the best start moment per segment it
  // was recommended for. A failed clip just keeps clip_start null.
  const clipTargets = new Map<string, Array<{ n: number; target: MatchTarget }>>();
  targets.forEach((t, n) => {
    for (const c of out.get(t.segment.id) ?? []) {
      const list = clipTargets.get(c.filename) ?? [];
      list.push({ n, target: t });
      clipTargets.set(c.filename, list);
    }
  });
  const queue = Array.from(clipTargets.entries());
  const run = async ([filename, list]: (typeof queue)[number]) => {
    const trimTargets: TrimTarget[] = list.map(({ n, target }) => ({
      shot_index: n,
      duration: Math.round((target.resolved.end - target.resolved.start) * 10) / 10,
      description: [target.segment.phrase, target.segment.description].filter(Boolean).join(" — "),
      camera_style: "static",
    }));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { windows } = await generateTrimWindows(ai, filename, catalogByName.get(filename)?.duration ?? null, trimTargets);
        for (const { n, target } of list) {
          const w = windows.get(n);
          if (!w) continue;
          for (const c of out.get(target.segment.id) ?? []) {
            if (c.filename !== filename) continue;
            c.clip_start = w.start;
            c.moment_note = w.note;
          }
        }
        return;
      } catch (error) {
        console.error(`B-roll trim stage failed for ${filename} (attempt ${attempt + 1}):`, error);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };
  const workers = Array.from({ length: 2 }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) return;
      await run(next);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- Moment finder: which phrases deserve B-roll ------------------------

export async function suggestBrollMoments(
  ai: GoogleGenAI,
  analysis: Analysis,
  words: Word[] | null,
  existing: Array<{ segment: BrollSegment; resolved: ResolvedBroll }>
): Promise<BrollSegment[]> {
  const total = analysis.shots[analysis.shots.length - 1]?.end_time ?? 0;
  const brand = getBrandConfig();
  const now = new Date().toISOString();
  const lastIndex = analysis.shots.length - 1;
  const rules = `Rules:
- Pick 2-6 moments in total, each 1.5-5 seconds of speech (roughly 4-14
  words), on phrases that name something SHOWABLE with product footage
  (the product, the screen, a step, a result). Skip vague or emotional
  lines — the speaker's face carries those.
- Never cover the first 1.5 seconds of shot 0 (the hook needs the face)
  and never cover shot ${lastIndex} (the close).
- Keep total coverage under 35% of the ${total.toFixed(0)}s video.
- Do not overlap the already-covered ranges listed.
- description: ONE concrete sentence of what the B-roll should show, in
  terms a footage library could match (the ${brand.name} product is
  ${brand.product.description}).`;

  const wordMode = !!words?.length && analysis.shots.every((s) => s.source_start != null);
  if (wordMode) {
    const shotsText = analysis.shots
      .map((s) => {
        const ws = wordsForShot(words!, s);
        if (!ws.length) return `Shot ${s.index} [${(s.end_time - s.start_time).toFixed(1)}s]: (no speech)`;
        return `Shot ${s.index} [${(s.end_time - s.start_time).toFixed(1)}s, words ${ws[0].i}-${ws[ws.length - 1].i}]:\n${ws
          .map((w) => `${w.i}:${w.word}`)
          .join(" ")}`;
      })
      .join("\n\n");
    const covered = existing
      .filter((e) => e.segment.anchor.kind === "words")
      .map((e) => {
        const a = e.segment.anchor as Extract<BrollSegment["anchor"], { kind: "words" }>;
        return `shot ${a.shot_index} words ${a.start_word}-${a.end_word}`;
      });
    const prompt = `You are choosing where B-roll should cover a talking-head short. The
video: ${analysis.summary}

The transcript below is numbered word by word (index:word) and grouped by
shot. A moment is a word range within ONE shot.

${rules}

ALREADY COVERED (avoid): ${covered.length ? covered.join("; ") : "nothing yet"}

TRANSCRIPT:
${shotsText}`;
    const { result } = await callJson(ai, prompt, geminiBrollMomentsResponseSchema, (raw) => GeminiBrollMomentsZ.parse(raw));
    const segments: BrollSegment[] = [];
    for (const m of result.moments) {
      const shot = analysis.shots.find((s) => s.index === m.shot_index);
      if (!shot || m.end_word < m.start_word) continue;
      const anchor = { kind: "words" as const, shot_index: shot.index, start_word: m.start_word, end_word: m.end_word };
      segments.push({
        id: randomUUID().slice(0, 8),
        anchor,
        clip: null,
        status: "suggested",
        phrase: phraseForAnchor(anchor, words!),
        description: m.description,
        candidates: [],
        createdAt: now,
      });
    }
    return segments;
  }

  const shotsText = analysis.shots
    .map(
      (s) =>
        `Shot ${s.index} [${(s.end_time - s.start_time).toFixed(1)}s]: ${s.spoken_text || "(no speech)"}\n  visual: ${s.description}`
    )
    .join("\n");
  const covered = existing.map((e) => `${e.resolved.start.toFixed(1)}-${e.resolved.end.toFixed(1)}s`);
  const prompt = `You are choosing where B-roll should cover a talking-head short. The
video: ${analysis.summary}

Each shot is listed with its length and what is said in it. A moment is an
offset (seconds into the shot) plus a duration, within ONE shot.

${rules}

ALREADY COVERED (avoid): ${covered.length ? covered.join("; ") : "nothing yet"}

SHOTS:
${shotsText}`;
  const { result } = await callJson(ai, prompt, geminiBrollMomentsOffsetResponseSchema, (raw) =>
    GeminiBrollMomentsOffsetZ.parse(raw)
  );
  const segments: BrollSegment[] = [];
  for (const m of result.moments) {
    const shot = analysis.shots.find((s) => s.index === m.shot_index);
    if (!shot || m.duration < MIN_BROLL_SECONDS) continue;
    segments.push({
      id: randomUUID().slice(0, 8),
      anchor: { kind: "offset", shot_index: shot.index, offset: Math.max(0, m.offset), duration: m.duration },
      clip: null,
      status: "suggested",
      phrase: "",
      description: m.description,
      candidates: [],
      createdAt: now,
    });
  }
  return segments;
}

// ---- Moment pick: where to start inside one clip ------------------------

export async function pickBrollMoment(
  ai: GoogleGenAI,
  filename: string,
  clipDuration: number | null,
  segment: BrollSegment,
  resolved: ResolvedBroll
): Promise<{ clip_start: number; note: string } | null> {
  const { windows } = await generateTrimWindows(ai, filename, clipDuration, [
    {
      shot_index: 0,
      duration: Math.round((resolved.end - resolved.start) * 10) / 10,
      description: [segment.phrase, segment.description].filter(Boolean).join(" — "),
      camera_style: "static",
    },
  ]);
  const w = windows.get(0);
  return w ? { clip_start: w.start, note: w.note } : null;
}
