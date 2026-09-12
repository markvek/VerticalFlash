import { projectModel } from "@/lib/models/native";
import { clipDescription, clipTags } from "@/lib/library-metadata";
import { NextRequest, NextResponse } from "next/server";
import { getBrandConfig } from "@/lib/config";
import { loadLibrary } from "@/lib/library-store";
import { promises as fs } from "fs";
import { join, basename } from "path";
import { getGeminiClient, getGeminiModel } from "@/lib/gemini";
import { AnalysisZ, type Analysis } from "@/lib/analysis-schema";
import {
  EDIT_INTENTS,
  GeminiMatchesZ,
  geminiMatchesResponseSchema,
  ShotRecommendationsZ,
  type GeminiMatches,
  type Recommendation,
  type ShotRecommendations,
} from "@/lib/recommendation-schema";
import { generateTrimWindows, type TrimTarget } from "@/lib/trim-windows";
import type { ClipLibrary } from "@/lib/library-schema";
import {
  ShotGenerationsZ,
  generatedClipDir,
  generationPath,
  isGeneratedClip,
  type ShotGenerations,
} from "@/lib/generation-schema";
import { createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { ANALYSIS_DIR, LIBRARY_DIR } from "@/lib/paths";


// Stage 2 uploads each recommended clip to Gemini — can take a while
export const maxDuration = 300;

const CONFIDENCE_SCORE = { strong: 3, moderate: 2, weak: 1 } as const;
const MAX_RECS_PER_SHOT = 4;
// Tag overlap grades a match rather than gating it: the combined score
// (Gemini confidence + overlap boost) maps back to the displayed tier.
const STRONG_SCORE = 3.5;
const MODERATE_SCORE = 2;

function scoreToConfidence(score: number): "strong" | "moderate" | "weak" {
  if (score >= STRONG_SCORE) return "strong";
  if (score >= MODERATE_SCORE) return "moderate";
  return "weak";
}

interface CatalogClip {
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

function recommendationsPath(videoId: string): string {
  return join(ANALYSIS_DIR, `${videoId}.recommendations.json`);
}

async function loadAnalysis(videoId: string): Promise<Analysis | null> {
  try {
    const raw = await fs.readFile(join(ANALYSIS_DIR, `${videoId}.json`), "utf8");
    return AnalysisZ.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Only clips that have been through Gemini analysis are matchable
async function loadCatalog(): Promise<CatalogClip[]> {
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
      tags: Array.from(
        new Set(
          clipTags(v).map(normalizeTag)
        )
      ),
    }));
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

// Clip duration from the library metadata, when recorded
async function lookupClipDuration(filename: string): Promise<number | null> {
  try {
    const library = await loadLibrary();
    return library.videos.find((v) => v.filename === filename)?.duration ?? null;
  } catch {
    return null;
  }
}

// A user's pick from the full library, stored as a first-class
// recommendation so the cards, timeline, and renderer all see it
function manualRecommendation(
  filename: string,
  duration: number | null
): Recommendation {
  return {
    filename,
    duration,
    confidence: "moderate",
    reason: "Selected from the clip library",
    source: "manual",
    tag_overlap: [],
    score: 0,
    trim_start: null,
    trim_end: null,
    moment_note: null,
  };
}

// The accepted attempt behind a generated selection, for rebuilding its
// recommendation card (duration + explicit trims) after a re-match
async function generatedRecommendation(
  videoId: string,
  shotIndex: number,
  filename: string
): Promise<Recommendation> {
  let duration: number | null = null;
  let kind: "generate" | "extend" = "generate";
  let sourceClip: string | null = null;
  try {
    const raw = await fs.readFile(generationPath(videoId), "utf8");
    const generations: ShotGenerations = ShotGenerationsZ.parse(
      JSON.parse(raw)
    );
    const attempt = generations.shots[String(shotIndex)]?.attempts.find(
      (a) => a.file === filename
    );
    if (attempt) {
      duration = attempt.duration;
      kind = attempt.kind;
      sourceClip = attempt.source_clip;
    }
  } catch {
    // sidecar missing — keep null trims; the renderer cuts from 0
  }
  return {
    filename,
    duration,
    confidence: "strong",
    reason:
      kind === "extend"
        ? `AI-extended from ${sourceClip ?? "a library clip"}`
        : "AI-generated for this shot",
    source: "generated",
    tag_overlap: [],
    score: 3,
    trim_start: duration != null ? 0 : null,
    trim_end: duration,
    moment_note: kind === "extend" ? "extended clip" : "generated clip",
  };
}

function tagOverlap(shotTags: string[], clipTags: string[]): string[] {
  const clipSet = new Set(clipTags);
  return Array.from(new Set(shotTags.map(normalizeTag))).filter((t) =>
    clipSet.has(t)
  );
}

function buildPrompt(analysis: Analysis, catalog: CatalogClip[]): string {
  const shots = analysis.shots.map((s) => ({
    shot_index: s.index,
    duration_s: Math.round((s.end_time - s.start_time) * 10) / 10,
    description: s.description,
    camera_style: s.camera_style,
    on_screen_text: s.on_screen_text || undefined,
    tags: s.tags?.length ? s.tags : undefined,
  }));

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
  return `You are helping a content team remake a successful TikTok video using
their own raw footage library. The original video is a "${analysis.format}"
format: ${analysis.summary}

Below are (A) the original video's shot list and (B) the team's footage
library ("${brand.name}" brand — ${brand.product.description}).

For EVERY shot in list A, recommend clips from list B that could play the
same role in a remake. Judge a match primarily on:
1. WHAT HAPPENS — the subject and action (e.g. a hand presenting one product
   to camera matches a hand presenting one product to camera, even if the
   products differ).
2. CAMERA MOVEMENT compatibility — same movement is best; a "static" or
   "stable" clip can also stand in for a pan/zoom shot (editors can add a
   digital pan or punch-in), but shaky handheld cannot stand in for static.
3. The shot's role in the video (hook, product beat, wide context shot,
   detail insert) and whether the clip could serve it at roughly the shot's
   duration (clips may be trimmed, so longer clips are fine; a clip much
   shorter than the shot is a problem).
4. LIGHTING consistency — prefer clips whose time_of_day matches the shot's
   lighting; the final edit cuts clips together, so mixing day and night
   footage looks jarring (indoor_lighting/unclear clips fit anywhere).

Rules:
- Recommend 0-3 clips per shot, best first. An empty list is CORRECT when
  nothing fits — do not force weak matches.
- confidence: "strong" (clearly plays the same role), "moderate" (works
  with editing/trimming), "weak" (plausible fallback).
- reason: ONE short sentence naming the concrete parallel (subject/action/
  camera), not generic praise.
- filename must be copied EXACTLY from list B.
- Include every shot_index from list A exactly once in your response.

A. ORIGINAL VIDEO SHOTS:
${JSON.stringify(shots, null, 1)}

B. FOOTAGE LIBRARY:
${JSON.stringify(clips, null, 1)}`;
}

async function generateMatches(
  ai: GoogleGenAI,
  analysis: Analysis,
  catalog: CatalogClip[]
): Promise<{ matches: GeminiMatches; usage: Record<string, unknown> | undefined }> {
  const basePrompt = buildPrompt(analysis, catalog);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: Your previous response was rejected (${
            lastError instanceof Error ? lastError.message : "invalid JSON"
          }). Return ONLY valid JSON matching the provided schema.`;

    const response = await ai.models.generateContent({
      model: getGeminiModel(ai),
      contents: createUserContent([prompt]),
      config: {
        responseMimeType: "application/json",
        responseSchema: geminiMatchesResponseSchema,
      },
    });

    const rawText = response.text ?? "";
    try {
      return {
        matches: GeminiMatchesZ.parse(JSON.parse(rawText)),
        usage: response.usageMetadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `Match response failed validation (attempt ${attempt + 1}):`,
        error,
        "\nraw:",
        rawText.slice(0, 2000)
      );
    }
  }

  throw new Error(
    `Gemini returned invalid matches after retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

// Merge Gemini's semantic matches (primary) with tag-overlap matches
// (secondary): overlap boosts Gemini picks and surfaces clips Gemini missed.
function mergeRecommendations(
  analysis: Analysis,
  catalog: CatalogClip[],
  matches: GeminiMatches
): ShotRecommendations["shots"] {
  const catalogByName = new Map(catalog.map((c) => [c.filename, c]));
  const geminiByShot = new Map(
    matches.matches.map((m) => [m.shot_index, m.recommendations])
  );

  return analysis.shots.map((shot) => {
    const shotTags = (shot.tags || []).map(normalizeTag);
    const recs: Recommendation[] = [];
    const seen = new Set<string>();

    for (const rec of geminiByShot.get(shot.index) || []) {
      const clip = catalogByName.get(rec.filename);
      // Drop hallucinated filenames and duplicates
      if (!clip || seen.has(clip.filename)) continue;
      seen.add(clip.filename);
      const overlap = tagOverlap(shotTags, clip.tags);
      const score =
        CONFIDENCE_SCORE[rec.confidence] + 0.5 * Math.min(overlap.length, 4);
      recs.push({
        filename: clip.filename,
        duration: clip.duration,
        // Gemini's confidence is the base signal; heavy tag overlap can
        // promote the displayed tier
        confidence: scoreToConfidence(score),
        reason: rec.reason,
        source: "gemini",
        tag_overlap: overlap,
        score,
        trim_start: null,
        trim_end: null,
        moment_note: null,
      });
    }

    // Secondary pass: pure tag matches Gemini didn't pick. Any shared tag
    // makes a candidate — the score sort and per-shot cap keep thin
    // matches from crowding the list.
    if (shotTags.length) {
      for (const clip of catalog) {
        if (seen.has(clip.filename)) continue;
        const overlap = tagOverlap(shotTags, clip.tags);
        if (overlap.length === 0) continue;
        seen.add(clip.filename);
        const score = 0.5 * overlap.length;
        recs.push({
          filename: clip.filename,
          duration: clip.duration,
          confidence: scoreToConfidence(score),
          reason: `Shares tags: ${overlap.join(", ")}`,
          source: "tags",
          tag_overlap: overlap,
          score,
          trim_start: null,
          trim_end: null,
          moment_note: null,
        });
      }
    }

    recs.sort((a, b) => b.score - a.score);
    return {
      shot_index: shot.index,
      recommendations: recs.slice(0, MAX_RECS_PER_SHOT),
    };
  });
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
    const raw = await fs.readFile(recommendationsPath(videoId), "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json(
      { error: "No recommendations found for this video" },
      { status: 404 }
    );
  }
}

// Save/clear the user's confirmed clip choice, remake edit intent, and/or
// "use original footage" flag (keep_source) for one shot.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let shotIndex: number;
  let filename: string | null = null;
  let hasFilename = false;
  let editIntent: (typeof EDIT_INTENTS)[number] | null | undefined;
  let keepSource: boolean | null | undefined;
  try {
    const body = await request.json();
    shotIndex = body.shot_index;
    hasFilename = Object.prototype.hasOwnProperty.call(body, "filename");
    filename = body.filename ?? null;
    editIntent =
      Object.prototype.hasOwnProperty.call(body, "edit_intent")
        ? body.edit_intent
        : undefined;
    keepSource = Object.prototype.hasOwnProperty.call(body, "keep_source")
      ? body.keep_source
      : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (typeof shotIndex !== "number") {
    return NextResponse.json(
      { error: "shot_index is required" },
      { status: 400 }
    );
  }
  if (
    editIntent !== undefined &&
    editIntent !== null &&
    !EDIT_INTENTS.includes(editIntent)
  ) {
    return NextResponse.json(
      { error: "invalid edit_intent" },
      { status: 400 }
    );
  }
  if (
    keepSource !== undefined &&
    keepSource !== null &&
    typeof keepSource !== "boolean"
  ) {
    return NextResponse.json(
      { error: "keep_source must be a boolean or null" },
      { status: 400 }
    );
  }

  try {
    const raw = await fs.readFile(recommendationsPath(videoId), "utf8");
    const stored = ShotRecommendationsZ.parse(JSON.parse(raw));
    const shot = stored.shots.find((s) => s.shot_index === shotIndex);
    if (!shot) {
      return NextResponse.json({ error: "Unknown shot_index" }, { status: 404 });
    }
    // Any clip in the library is selectable (the All Clips picker
    // browses beyond the per-shot recommendations); unknown names are
    // still rejected
    if (hasFilename && filename !== null) {
      if (basename(filename) !== filename) {
        return NextResponse.json({ error: "invalid filename" }, { status: 400 });
      }
      // Generated clips live in generated/<videoId>/, not the library
      const clipDir = isGeneratedClip(filename)
        ? generatedClipDir(videoId)
        : LIBRARY_DIR;
      try {
        await fs.access(join(clipDir, filename));
      } catch {
        return NextResponse.json(
          { error: "filename is not in the clip library" },
          { status: 400 }
        );
      }
      if (!shot.recommendations.some((r) => r.filename === filename)) {
        shot.recommendations.push(
          isGeneratedClip(filename)
            ? await generatedRecommendation(videoId, shotIndex, filename)
            : manualRecommendation(filename, await lookupClipDuration(filename))
        );
      }
    }
    if (hasFilename) {
      shot.selected_filename = filename;
    }
    if (editIntent !== undefined) {
      shot.edit_intent = editIntent;
    }
    if (keepSource !== undefined) {
      shot.keep_source = keepSource;
    }
    // Manual entries only exist to carry a selection — drop any that are
    // no longer the pick so cleared choices don't linger as cards
    if (hasFilename) {
      shot.recommendations = shot.recommendations.filter(
        (r) => r.source !== "manual" || r.filename === filename
      );
    }
    await fs.writeFile(
      recommendationsPath(videoId),
      JSON.stringify(stored, null, 2)
    );
    return NextResponse.json(stored);
  } catch (error) {
    console.error("selection save failed:", error);
    return NextResponse.json(
      { error: "No recommendations found for this video" },
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

  const analysis = await loadAnalysis(videoId);
  if (!analysis) {
    return NextResponse.json(
      { error: "Run the Gemini shot analysis first — no analysis found" },
      { status: 404 }
    );
  }

  let catalog: CatalogClip[];
  try { catalog = await loadCatalog(); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load clip catalog" }, { status: 500 }); }
  if (catalog.length === 0) {
    return NextResponse.json(
      {
        error:
          "No analyzed clips to match against — analyze clips in the library first",
      },
      { status: 400 }
    );
  }

  let ai: GoogleGenAI;
  try {
    ai = getGeminiClient(await projectModel(videoId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Gemini not configured" },
      { status: 500 }
    );
  }

  try {
    const { matches, usage } = await generateMatches(ai, analysis, catalog);
    const shots = mergeRecommendations(analysis, catalog, matches);

    // Re-matching must not wipe the user's confirmed clip choices: carry
    // each selection over as long as its clip is still in the library
    // (the renderer honors a selection even off the new rec list)
    try {
      const raw = await fs.readFile(recommendationsPath(videoId), "utf8");
      const previous = ShotRecommendationsZ.parse(JSON.parse(raw));
      // Selections can point at any library file (manual picks include
      // unanalyzed clips), so check the directory, not just the catalog
      const dirEntries = await fs
        .readdir(LIBRARY_DIR)
        .catch(() => [] as string[]);
      const stillInLibrary = new Set(
        dirEntries.filter((name) => !name.startsWith("."))
      );
      const previousByShot = new Map(
        previous.shots.map((s) => [
          s.shot_index,
          {
            selected: s.selected_filename ?? null,
            editIntent: s.edit_intent ?? null,
            keepSource: s.keep_source ?? null,
          },
        ])
      );
      for (const shot of shots) {
        const previousShot = previousByShot.get(shot.shot_index);
        if (previousShot?.editIntent) {
          shot.edit_intent = previousShot.editIntent;
        }
        // The "use original footage" flag is the user's call, not the
        // matcher's — it survives a re-match like a selection does
        if (previousShot?.keepSource != null) {
          shot.keep_source = previousShot.keepSource;
        }
        const selected = previousShot?.selected ?? null;
        if (selected && previousShot?.editIntent === "recycle") {
          shot.recommendations = shot.recommendations.filter(
            (r) => r.filename !== selected
          );
          continue;
        }
        if (!selected) continue;
        // Accepted generated clips live outside the library — a re-match
        // must never silently drop one
        const stillExists = isGeneratedClip(selected)
          ? await fs
              .access(join(generatedClipDir(videoId), selected))
              .then(() => true)
              .catch(() => false)
          : stillInLibrary.has(selected);
        if (!stillExists) continue;
        shot.selected_filename = selected;
        // Keep a manual pick visible (with its provenance) even when the
        // fresh match didn't recommend it
        if (!shot.recommendations.some((r) => r.filename === selected)) {
          shot.recommendations.push(
            isGeneratedClip(selected)
              ? await generatedRecommendation(
                  videoId,
                  shot.shot_index,
                  selected
                )
              : manualRecommendation(
                  selected,
                  await lookupClipDuration(selected)
                )
          );
        }
      }
    } catch {
      // first match for this video, or the old file is unreadable
    }

    // Stage 2: for each recommended clip, watch it and pick the moment
    // within it that fits each target shot's duration
    const shotByIndex = new Map(analysis.shots.map((s) => [s.index, s]));
    const catalogByName = new Map(catalog.map((c) => [c.filename, c]));
    const clipTargets = new Map<string, TrimTarget[]>();
    for (const s of shots) {
      const shot = shotByIndex.get(s.shot_index);
      if (!shot) continue;
      for (const r of s.recommendations) {
        // Generated clips carry explicit trims and aren't library files
        if (isGeneratedClip(r.filename)) continue;
        const targets = clipTargets.get(r.filename) || [];
        targets.push({
          shot_index: s.shot_index,
          duration:
            Math.round((shot.end_time - shot.start_time) * 10) / 10,
          description: shot.description,
          camera_style: shot.camera_style,
        });
        clipTargets.set(r.filename, targets);
      }
    }

    const usageTotals = {
      prompt: (usage?.promptTokenCount as number) ?? 0,
      output: (usage?.candidatesTokenCount as number) ?? 0,
      total: (usage?.totalTokenCount as number) ?? 0,
    };

    // One upload + one call per unique clip; a failed clip just keeps
    // null trims instead of failing the whole match. Low concurrency and
    // one retry, because the video calls are prone to transient 503s.
    const trimQueue = Array.from(clipTargets.entries());
    const runTrim = async ([filename, targets]: (typeof trimQueue)[number]) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { windows, usage: trimUsage } = await generateTrimWindows(
            ai,
            filename,
            catalogByName.get(filename)?.duration ?? null,
            targets
          );
          usageTotals.prompt += (trimUsage?.promptTokenCount as number) ?? 0;
          usageTotals.output += (trimUsage?.candidatesTokenCount as number) ?? 0;
          usageTotals.total += (trimUsage?.totalTokenCount as number) ?? 0;
          for (const s of shots) {
            const w = windows.get(s.shot_index);
            if (!w) continue;
            for (const r of s.recommendations) {
              if (r.filename !== filename) continue;
              r.trim_start = w.start;
              r.trim_end = w.end;
              r.moment_note = w.note;
            }
          }
          return;
        } catch (error) {
          console.error(
            `trim stage failed for ${filename} (attempt ${attempt + 1}):`,
            error
          );
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 10_000));
          }
        }
      }
    };
    const CONCURRENCY = 2;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (trimQueue.length) {
        const next = trimQueue.shift();
        if (!next) return;
        await runTrim(next);
      }
    });
    await Promise.all(workers);

    const stored: ShotRecommendations = {
      videoId,
      generatedAt: new Date().toISOString(),
      model: getGeminiModel(ai),
      clipsConsidered: catalog.length,
      shots,
      usage: {
        promptTokens: usageTotals.prompt || undefined,
        outputTokens: usageTotals.output || undefined,
        totalTokens: usageTotals.total || undefined,
      },
    };

    await fs.writeFile(
      recommendationsPath(videoId),
      JSON.stringify(ShotRecommendationsZ.parse(stored), null, 2)
    );

    return NextResponse.json(stored);
  } catch (error) {
    console.error("recommendations failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Matching failed" },
      { status: 500 }
    );
  }
}
