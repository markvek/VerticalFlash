import type { Analysis } from "./analysis-schema";
import type { ShotRecommendations, Recommendation } from "./recommendation-schema";

/** A suggested moment must cover the whole slot without an implicit fill. */
export function coversSegment(rec: Recommendation, seconds: number): boolean {
  return rec.duration != null && rec.trim_start != null && rec.trim_end != null &&
    rec.trim_start >= 0 && rec.trim_end - rec.trim_start >= seconds - 0.001 &&
    rec.duration - rec.trim_start >= seconds - 0.001;
}

export function seedReferenceDraft(analysis: Analysis, matches: ShotRecommendations, previous?: ShotRecommendations | null): ShotRecommendations {
  const claimed = new Set(previous?.shots.filter(s => s.choice_origin !== "automatic" && s.selected_filename).map(s => s.selected_filename!) ?? []);
  return { ...matches, mode: "reference", shots: analysis.shots.map(shot => {
    const next = { ...(matches.shots.find(s => s.shot_index === shot.index) ?? { shot_index: shot.index, recommendations: [] }) };
    const prior = previous?.shots.find(s => s.shot_index === shot.index);
    // Keep both the chosen file and its exact moment, including a missing
    // file: preview/export surface that problem instead of changing the pick.
    if (prior && prior.choice_origin !== "automatic" && (prior.selected_filename || (prior.keep_source && !prior.needs_replacement))) {
      const picked = prior.recommendations.find(r => r.filename === prior.selected_filename);
      return { ...next, selected_filename: prior.selected_filename, keep_source: prior.keep_source,
        choice_origin: prior.choice_origin ?? "user", needs_replacement: false,
        recommendations: picked ? [picked, ...next.recommendations.filter(r => r.filename !== picked.filename)] : next.recommendations };
    }
    const eligible = next.recommendations.filter(r => r.confidence !== "weak" && coversSegment(r, shot.end_time - shot.start_time));
    const best = eligible.find(r => !claimed.has(r.filename)) ?? eligible[0];
    if (best) claimed.add(best.filename);
    return { ...next, selected_filename: best?.filename ?? null, keep_source: !best,
      choice_origin: "automatic" as const, needs_replacement: !best };
  }) };
}
