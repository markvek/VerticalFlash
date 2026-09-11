import { withProjectEdit } from "@/lib/project-edit-lock";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { promises as fs } from "fs";
import { join } from "path";
import type { GoogleGenAI } from "@google/genai";
import { AnalysisZ, type Analysis } from "@/lib/analysis-schema";
import { BrollSegmentZ, type BrollSegment, type BrollTrack } from "@/lib/broll-schema";
import { readBrollTrack, writeBrollTrack } from "@/lib/broll-store";
import {
  brollOverlaps,
  resolveBrollTrack,
  type ResolvedBroll,
} from "@/lib/broll-resolve";
import {
  loadBrollCatalog,
  matchBrollSegments,
  pickBrollMoment,
  suggestBrollMoments,
} from "@/lib/broll-match";
import { cutdownSourceShots, withSourceRanges } from "@/lib/cutdown-build";
import { readMasterSegments } from "@/lib/master-analyze";
import { readProjectMeta } from "@/lib/project-meta";
import { findDownloadFile } from "@/lib/download-files";
import { classifyGeminiError, getGeminiClient } from "@/lib/gemini";
import { ANALYSIS_DIR } from "@/lib/paths";
import type { Word } from "@/lib/segments-schema";

// The short's B-roll track: voice-anchored segments over the speaker.
// GET/PUT store it; POST runs the Gemini stages (suggest, match, moment).

export const maxDuration = 300;

const inFlight = new Set<string>();

interface Context {
  analysis: Analysis;
  words: Word[] | null;
  clipDurations: Map<string, number | null>;
}

async function loadContext(videoId: string): Promise<Context | null> {
  let analysis: Analysis;
  try {
    analysis = AnalysisZ.parse(JSON.parse(await fs.readFile(join(ANALYSIS_DIR, `${videoId}.json`), "utf8")));
  } catch {
    return null;
  }
  const file = await findDownloadFile(videoId);
  const meta = file ? await readProjectMeta(file.path) : null;
  let words: Word[] | null = null;
  if (meta?.kind === "cutdown") {
    analysis = withSourceRanges(analysis, meta);
    // Attached-footage beats have no master words; leave them offset-anchored
    const footage = await cutdownSourceShots(meta).catch(() => []);
    analysis = {
      ...analysis,
      shots: analysis.shots.map((s, i) => (footage[i] && meta.beats[i]?.source ? { ...s, source_start: undefined, source_end: undefined } : s)),
    };
    words = (await readMasterSegments(meta.masterId))?.words ?? null;
  }
  return { analysis, words, clipDurations: new Map() };
}

function respond(track: BrollTrack, resolved: ResolvedBroll[], extra: Record<string, unknown> = {}) {
  return NextResponse.json({ track, resolved, ...extra });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  const ctx = await loadContext(videoId);
  if (!ctx) return NextResponse.json({ error: "No analysis found for this video" }, { status: 404 });
  const track = await readBrollTrack(videoId);
  return respond(track, resolveBrollTrack(track, ctx.analysis.shots, ctx.words));
}

const PutBodyZ = z.object({ segments: z.array(BrollSegmentZ) });

// Replace the whole track (the client always holds the full list)
async function put(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  let segments: BrollSegment[];
  try {
    segments = PutBodyZ.parse(await request.json()).segments;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ")
            : "Invalid request",
      },
      { status: 400 }
    );
  }
  const ctx = await loadContext(videoId);
  if (!ctx) return NextResponse.json({ error: "No analysis found for this video" }, { status: 404 });
  const ids = new Set<string>();
  for (const s of segments) {
    if (ids.has(s.id)) return NextResponse.json({ error: `Duplicate segment id ${s.id}` }, { status: 400 });
    ids.add(s.id);
  }
  const resolved = resolveBrollTrack({ segments }, ctx.analysis.shots, ctx.words);
  const overlaps = brollOverlaps(resolved.filter((r) => segments.find((s) => s.id === r.id)?.status === "placed"));
  if (overlaps.length) {
    const [a, b] = overlaps[0];
    return NextResponse.json(
      { error: `Two placed B-roll segments overlap (${a.start.toFixed(1)}–${a.end.toFixed(1)}s and ${b.start.toFixed(1)}–${b.end.toFixed(1)}s)` },
      { status: 400 }
    );
  }
  const previous = await readBrollTrack(videoId);
  const track = await writeBrollTrack({ ...previous, videoId, segments });
  return respond(track, resolved);
}

const PostBodyZ = z.object({
  action: z.enum(["suggest", "match", "moment"]),
  segment_ids: z.array(z.string()).optional(),
});

// Gemini stages. "suggest" finds moments and matches clips for them;
// "match" fills candidates for placeholders (or the given segments);
// "moment" re-picks where the chosen clip starts for the given segments.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  let body: z.infer<typeof PostBodyZ>;
  try {
    body = PostBodyZ.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const ctx = await loadContext(videoId);
  if (!ctx) return NextResponse.json({ error: "No analysis found for this video" }, { status: 404 });

  let ai: GoogleGenAI;
  try {
    ai = getGeminiClient();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Gemini not configured" }, { status: 500 });
  }
  if (inFlight.has(videoId)) {
    return NextResponse.json({ error: "A B-roll step is already running for this video" }, { status: 409 });
  }
  inFlight.add(videoId);
  try {
    let track = await readBrollTrack(videoId);
    const byId = (segments: BrollSegment[]) => new Map(segments.map((s) => [s.id, s]));
    const resolvedMap = (segments: BrollSegment[]) =>
      new Map(resolveBrollTrack({ segments }, ctx.analysis.shots, ctx.words).map((r) => [r.id, r]));

    let toMatch: BrollSegment[] = [];
    if (body.action === "suggest") {
      const existing = resolveBrollTrack(track, ctx.analysis.shots, ctx.words)
        .filter((r) => r.valid)
        .map((r) => ({ segment: byId(track.segments).get(r.id)!, resolved: r }));
      const fresh = await suggestBrollMoments(ai, ctx.analysis, ctx.words, existing);
      // Drop suggestions that collide with anything already on the track
      const trial = [...track.segments, ...fresh];
      const resolvedTrial = resolvedMap(trial);
      const kept = fresh.filter((f) => {
        const r = resolvedTrial.get(f.id);
        if (!r?.valid) return false;
        return !track.segments.some((s) => {
          const o = resolvedTrial.get(s.id);
          return o?.valid && o.start < r.end && r.start < o.end;
        });
      });
      // Earlier unaccepted suggestions are replaced by the new set
      track = { ...track, segments: [...track.segments.filter((s) => s.status !== "suggested"), ...kept], suggestedAt: new Date().toISOString() };
      toMatch = kept;
    } else if (body.action === "match") {
      const wanted = body.segment_ids?.length ? new Set(body.segment_ids) : null;
      toMatch = track.segments.filter((s) => (wanted ? wanted.has(s.id) : !s.clip && s.candidates.length === 0));
    } else {
      const wanted = new Set(body.segment_ids ?? []);
      const resolved = resolvedMap(track.segments);
      const catalog = await loadBrollCatalog();
      const durations = new Map(catalog.map((c) => [c.filename, c.duration]));
      for (const s of track.segments) {
        if (!wanted.has(s.id) || !s.clip) continue;
        const r = resolved.get(s.id);
        if (!r?.valid) continue;
        const pick = await pickBrollMoment(ai, s.clip.filename, durations.get(s.clip.filename) ?? null, s, r);
        if (pick) {
          s.clip = { ...s.clip, clip_start: pick.clip_start };
          const c = s.candidates.find((c) => c.filename === s.clip!.filename);
          if (c) {
            c.clip_start = pick.clip_start;
            c.moment_note = pick.note;
          }
        }
      }
      const saved = await writeBrollTrack(track);
      return respond(saved, resolveBrollTrack(saved, ctx.analysis.shots, ctx.words));
    }

    if (toMatch.length) {
      const catalog = await loadBrollCatalog();
      if (catalog.length === 0) {
        return NextResponse.json(
          { error: "No analyzed clips to match against — analyze clips in the library first" },
          { status: 400 }
        );
      }
      const resolved = resolvedMap(track.segments);
      const targets = toMatch
        .map((segment) => ({ segment, resolved: resolved.get(segment.id)! }))
        .filter((t) => t.resolved?.valid);
      const candidates = await matchBrollSegments(ai, ctx.analysis, targets, catalog);
      for (const s of track.segments) {
        const found = candidates.get(s.id);
        if (!found) continue;
        s.candidates = found;
        // Suggestions arrive complete: the best candidate becomes the clip
        if (!s.clip && s.status === "suggested" && found[0]) {
          s.clip = { filename: found[0].filename, clip_start: found[0].clip_start, source: "library" };
        }
      }
    }
    const saved = await writeBrollTrack(track);
    return respond(saved, resolveBrollTrack(saved, ctx.analysis.shots, ctx.words), {
      matched: toMatch.map((s) => s.id),
    });
  } catch (error) {
    console.error("B-roll step failed:", error);
    const { kind } = classifyGeminiError(error);
    const status = kind === "rate_limit" || kind === "daily_quota" ? 429 : kind === "unavailable" ? 503 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "B-roll step failed" }, { status });
  } finally {
    inFlight.delete(videoId);
  }
}

export async function PUT(request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await context.params;
  return withProjectEdit(videoId, () => put(request, context));
}
