// Match published TikTok posts back to local remake renders. Pure scoring —
// no fs access — so the API route feeds it candidates and later phases (a
// persisted link store, the downloads dashboard) can reuse it.
//
// Deterministic matching is impossible with the drafts upload flow (TikTok
// never reports the published aweme_id back), so this scores every published
// video against every render on three signals and only claims a match when
// the winner is both strong and unambiguous.

// The published-post facts that matter for matching (subset of TikTokVideoStats)
export interface PublishedFacts {
  id: string;
  // The caption as posted (TikTok calls it title)
  title: string;
  // Integer seconds
  duration: number;
  // Unix seconds
  createTime: number;
}

export interface RenderCandidate {
  videoId: string;
  // The download filename (manifest.sourceVideo) — the /downloads/[filename] param
  filename: string;
  durationSeconds: number;
  // ISO timestamp from the render manifest
  renderedAt: string;
  // Caption texts offered for this video (captions file + publish records) —
  // the user pastes one when posting the draft, so a prefix match is strong
  captionOptions: string[];
  // ISO timestamp of the latest TikTok upload of this render (null = never
  // uploaded through the app, or predates publish records)
  uploadedAt: string | null;
}

export interface PublishedMatch {
  publishedId: string;
  videoId: string;
  filename: string;
  score: number;
}

// Only posts with real traction get matched back to local downloads — shared
// by the analytics table (Remake column) and the downloads page (winners
// sorted to the top)
export const MATCH_MIN_VIEWS = 1500;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Weights: duration + time (0.6 combined) must clear the accept threshold on
// their own because not every render has caption data; a caption hit is a
// bonus that lifts a match well clear of the margin rule.
const WEIGHT_DURATION = 0.4;
const WEIGHT_TIME = 0.2;
const WEIGHT_CAPTION = 0.4;
const ACCEPT_SCORE = 0.5;
const ACCEPT_MARGIN = 0.15;
// Tolerant on purpose: the user rewrites captions when posting, so partial
// overlap is common on true matches, and a wrong-but-similar caption can only
// mislead when the margin rule fails to separate candidates anyway
const JACCARD_FLOOR = 0.4;

// Lowercase, drop hashtags, strip emoji/punctuation, collapse whitespace —
// captions get hashtags appended, casing tweaked, and emoji swapped when posted
function normalizeCaption(text: string): string {
  return text
    .toLowerCase()
    .replace(/#[^\s#]+/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Fold trivial plurals so "owner"/"owners" count as the same token
function canonicalToken(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function tokenJaccard(a: string, b: string): number {
  const tokensA = new Set(a.split(" ").filter(Boolean).map(canonicalToken));
  const tokensB = new Set(b.split(" ").filter(Boolean).map(canonicalToken));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  return intersection / (tokensA.size + tokensB.size - intersection);
}

function captionScore(publishedTitle: string, options: string[]): number {
  const title = normalizeCaption(publishedTitle);
  if (!title) return 0;
  let best = 0;
  for (const option of options) {
    const normalized = normalizeCaption(option);
    if (!normalized) continue;
    // Posted caption starts with a stored option = the user pasted it
    // (hashtags and trailing additions already stripped/tolerated)
    if (title.startsWith(normalized)) return WEIGHT_CAPTION;
    const jaccard = tokenJaccard(title, normalized);
    if (jaccard >= JACCARD_FLOOR) best = Math.max(best, WEIGHT_CAPTION * jaccard);
  }
  return best;
}

// Score one candidate for one published video; null = fails a hard filter
export function scoreCandidate(
  video: PublishedFacts,
  candidate: RenderCandidate
): number | null {
  const publishedMs = video.createTime * 1000;

  // Upload records are append-only and truthful, so a post genuinely can't
  // predate its upload (1h slack for clock skew). renderedAt gets NO hard
  // filter: re-renders overwrite it in place, so a post can legitimately
  // predate the manifest's current render date.
  const uploadedMs = candidate.uploadedAt
    ? Date.parse(candidate.uploadedAt)
    : NaN;
  if (!Number.isNaN(uploadedMs) && publishedMs < uploadedMs - HOUR_MS)
    return null;

  const renderedMs = Date.parse(candidate.renderedAt);
  if (Number.isNaN(renderedMs) && Number.isNaN(uploadedMs)) return null;

  // Published duration is integer seconds — a real match rounds within ±1
  const durationDelta = Math.abs(candidate.durationSeconds - video.duration);
  if (Math.abs(Math.round(candidate.durationSeconds) - video.duration) > 1)
    return null;

  const duration = WEIGHT_DURATION * Math.max(0, 1 - durationDelta / 1.5);

  // Full credit within 7 days, fading to nothing at 30. Against an upload the
  // gap is one-sided (draft posted later); against a mutable renderedAt use
  // absolute distance, since either side can move (late post vs re-render).
  const days = !Number.isNaN(uploadedMs)
    ? Math.max(0, (publishedMs - uploadedMs) / DAY_MS)
    : Math.abs(publishedMs - renderedMs) / DAY_MS;
  const time =
    days <= 7
      ? WEIGHT_TIME
      : days >= 30
        ? 0
        : (WEIGHT_TIME * (30 - days)) / 23;

  return duration + time + captionScore(video.title, candidate.captionOptions);
}

// Best unambiguous match per published video. Videos with no clear winner
// (weak best, or a runner-up within the margin) get no match at all —
// pointing at the wrong download is worse than pointing at nothing.
export function matchPublished(
  videos: PublishedFacts[],
  candidates: RenderCandidate[]
): PublishedMatch[] {
  const matches: PublishedMatch[] = [];
  for (const video of videos) {
    const scored = candidates
      .map((c) => ({ candidate: c, score: scoreCandidate(video, c) }))
      .filter((s): s is { candidate: RenderCandidate; score: number } =>
        s.score !== null
      )
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < ACCEPT_SCORE) continue;
    if (scored.length > 1 && best.score - scored[1].score < ACCEPT_MARGIN)
      continue;

    matches.push({
      publishedId: video.id,
      videoId: best.candidate.videoId,
      filename: best.candidate.filename,
      score: Math.round(best.score * 100) / 100,
    });
  }
  return matches;
}
