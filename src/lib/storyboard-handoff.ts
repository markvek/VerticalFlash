import { randomUUID } from "crypto";
import type { Analysis } from "./analysis-schema";
import type { StoryboardHandoff, ViralityReview } from "./virality-schema";
import { DEFAULT_TEXT_STYLE, TextOverlaysZ, type TextOverlays } from "./text-overlays-schema";
import { type BrollSegment, type BrollCandidate } from "./broll-schema";
import { resolveBrollTrack } from "./broll-resolve";
import { loadBrollCatalog, matchBrollSegments } from "./broll-match";
import { getGeminiClient } from "./gemini";
import { findLibraryFile } from "./library-store";
import { probeDuration } from "./master-assemble";

export interface ReviewedHandoff { options: StoryboardHandoff; review: ViralityReview | null; model?: string }

// Explicit entries also suppress the renderer's detected-text fallback when
// the checkbox is off. Timing uses the final cut, which may be a little
// shorter than the storyboard after contiguous source windows are joined.
export function handoffText(analysis: Analysis, handoff: ReviewedHandoff): TextOverlays {
  return TextOverlaysZ.parse({ videoId: analysis.videoId, updatedAt: new Date().toISOString(), style: DEFAULT_TEXT_STYLE,
    shots: Object.fromEntries(analysis.shots.map(shot => {
      const suggestion = handoff.options.add_text ? handoff.review?.text.find(t => t.beat_index === shot.index) : null;
      const duration = shot.end_time - shot.start_time;
      const start = suggestion ? Math.min(suggestion.offset, duration) : 0;
      const end = suggestion ? Math.min(suggestion.offset + suggestion.duration, duration) : duration;
      return [String(shot.index), { text: suggestion?.text ?? "", include: !!suggestion && end > start, startOffset: start, endOffset: end, matchSpeech: false }];
    })),
  });
}

export function handoffBrollTargets(analysis: Analysis, handoff: ReviewedHandoff): BrollSegment[] {
  if (!handoff.options.add_broll) return [];
  return (handoff.review?.broll ?? []).flatMap(suggestion => {
    const shot = analysis.shots.find(s => s.index === suggestion.beat_index);
    if (!shot) return [];
    const duration = Math.min(suggestion.duration, shot.end_time - shot.start_time - suggestion.offset);
    if (duration < 1.5) return [];
    return [{ id: randomUUID(), anchor: { kind: "offset" as const, shot_index: shot.index, offset: suggestion.offset, duration }, clip: null, status: "suggested" as const, phrase: shot.spoken_text, description: `${suggestion.description} — ${suggestion.reason}`, candidates: [], createdAt: new Date().toISOString() }];
  });
}

export async function placeHandoffMatches(segments: BrollSegment[], matched: Map<string, BrollCandidate[]>, durationFor: (filename: string) => Promise<number | null>) {
  for (const segment of segments) {
    segment.candidates = matched.get(segment.id) ?? [];
    const duration = segment.anchor.kind === "offset" ? segment.anchor.duration : 0;
    for (const candidate of segment.candidates) {
      if (candidate.confidence !== "strong") continue;
      const available = await durationFor(candidate.filename);
      const start = Math.max(0, candidate.clip_start ?? 0);
      if (available == null || start + duration > available + 0.01) continue;
      segment.clip = { filename: candidate.filename, clip_start: start, source: "library" };
      segment.status = "placed";
      break;
    }
  }
}

export async function handoffBroll(analysis: Analysis, handoff: ReviewedHandoff, excluded: Set<string>): Promise<{ segments: BrollSegment[]; warnings: string[] }> {
  const segments = handoffBrollTargets(analysis, handoff);
  if (!segments.length) return { segments, warnings: handoff.options.add_broll ? ["The review did not identify a suitable B-roll window for this cut."] : [] };
  const warnings: string[] = [];
  try {
    const catalog = (await loadBrollCatalog()).filter(c => !excluded.has(c.filename));
    if (!catalog.length) return { segments, warnings: ["No analyzed B-roll clips are available. Suggested windows are saved for you to fill."] };
    const resolved = resolveBrollTrack({ segments }, analysis.shots, null);
    const targets = segments.flatMap(segment => {
      const r = resolved.find(r => r.id === segment.id);
      return r?.valid ? [{ segment, resolved: r }] : [];
    });
    const matched = await matchBrollSegments(getGeminiClient(handoff.model), analysis, targets, catalog);
    await placeHandoffMatches(segments, matched, async filename => {
      const path = await findLibraryFile(filename);
      return path ? probeDuration(path) : null;
    });
    const unplaced = segments.filter(s => s.status !== "placed").length;
    if (unplaced) warnings.push(`${unplaced} B-roll window${unplaced === 1 ? " has" : "s have"} no strong, usable library match. Source footage remains visible there.`);
  } catch (error) {
    warnings.push(`B-roll could not be completed: ${error instanceof Error ? error.message : "Matching failed"}. The edit and suggested windows are saved.`);
  }
  return { segments, warnings };
}
