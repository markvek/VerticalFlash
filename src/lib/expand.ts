import {
  fetchTagDetail,
  fetchTagPosts,
  harvestVideoItem,
  type CandidateTag,
  type DiscoveredTag,
  type DiscoveryData,
  type HarvestedVideo,
  type Video,
} from "@/lib/tikhub";

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const EXPAND_TOP_K = envInt("EXPAND_TOP_K", 6);
export const SHORTLIST_SIZE = envInt("SHORTLIST_SIZE", 10);
export const TAG_ZONE_MIN = envInt("TAG_ZONE_MIN", 10_000_000);
export const TAG_ZONE_MAX = envInt("TAG_ZONE_MAX", 500_000_000);
const POSTS_PER_PULL = 10;
const MAX_CANDIDATE_TAGS = 15;
const MAX_TRENDING_VIDEOS = 20;
const MAX_VIDEOS_PER_EXPANDED_TAG = 6;

// Tags too generic to tell us anything about a niche
export const GENERIC_TAG_STOPLIST = new Set([
  "fyp",
  "fypシ",
  "fypシ゚viral",
  "fypage",
  "fy",
  "foryou",
  "foryoupage",
  "foryourpage",
  "viral",
  "viralvideo",
  "viraltiktok",
  "trending",
  "trend",
  "tiktok",
  "xyzbca",
  "explore",
  "explorepage",
  "duet",
  "stitch",
  "capcut",
  "greenscreen",
  "parati",
  "pourtoi",
  "fürdich",
  "voorjou",
  "perte",
]);

export function normalizeTag(raw: string): string {
  return raw.replace(/^#/, "").trim().toLowerCase();
}

export function ownHandleFromUrl(tiktokUrl?: string): string | null {
  if (!tiktokUrl) return null;
  const match = tiktokUrl.match(/@([\w.]+)/);
  return match ? match[1].toLowerCase() : null;
}

export function isOwnVideo(video: Video, ownHandle: string | null): boolean {
  return ownHandle !== null && video.authorHandle.toLowerCase() === ownHandle;
}

export interface TagAggregate {
  name: string;
  challengeId?: string;
  score: number;
  occurrences: number;
}

// Score co-tags across a harvest: each distinct video containing a tag
// contributes 1 + log10(1 + its play count), so occurrence count dominates
// and engagement breaks ties
export function aggregateCoTags(
  harvest: HarvestedVideo[],
  exclude: Set<string>
): TagAggregate[] {
  const seenVideos = new Set<string>();
  const aggregates = new Map<string, TagAggregate>();

  for (const { video, coTags } of harvest) {
    if (seenVideos.has(video.id)) continue;
    seenVideos.add(video.id);

    const weight = 1 + Math.log10(1 + video.playCount);
    for (const tag of coTags) {
      if (!tag.name || exclude.has(tag.name)) continue;
      if (GENERIC_TAG_STOPLIST.has(tag.name)) continue;

      const agg = aggregates.get(tag.name) || {
        name: tag.name,
        challengeId: tag.id,
        score: 0,
        occurrences: 0,
      };
      agg.score += weight;
      agg.occurrences += 1;
      if (!agg.challengeId && tag.id) agg.challengeId = tag.id;
      aggregates.set(tag.name, agg);
    }
  }

  return [...aggregates.values()].sort((a, b) => b.score - a.score);
}

export function trendingScore(video: Video, followerCount?: number): number {
  const ageDays = Math.max(0.5, (Date.now() / 1000 - video.createdAt) / 86400);
  const velocity = video.playCount / ageDays;
  const outlierBoost =
    followerCount && followerCount > 0
      ? Math.min(10, Math.max(0.5, video.playCount / Math.max(followerCount, 1000)))
      : 1;
  return velocity * outlierBoost;
}

export function dedupeVideosById(videos: Video[]): Video[] {
  const byId = new Map<string, Video>();
  for (const video of videos) {
    if (!byId.has(video.id)) byId.set(video.id, video);
  }
  return [...byId.values()];
}

export async function buildDiscovery(opts: {
  harvest: HarvestedVideo[];
  seedTags: string[];
  tiktokUrl?: string;
  topK?: number;
  minViews?: number;
}): Promise<DiscoveryData | undefined> {
  const { harvest, seedTags, tiktokUrl } = opts;
  const topK = opts.topK ?? EXPAND_TOP_K;
  const minViews = opts.minViews ?? 0;

  if (harvest.length === 0) return undefined;

  const ownHandle = ownHandleFromUrl(tiktokUrl);
  const exclude = new Set(seedTags.map(normalizeTag));
  if (ownHandle) exclude.add(ownHandle);

  // Hop 1: rank co-tags across everything we harvested from the seeds
  const hop1Tags = aggregateCoTags(harvest, exclude);
  const shortlist = hop1Tags.slice(0, SHORTLIST_SIZE);

  // Size lookup: viewCount decides the zone, and the returned challengeId
  // makes name-only tags pullable
  const sizeResults = await Promise.allSettled(
    shortlist.map((tag) => fetchTagDetail(tag.name))
  );

  const inZone: Array<TagAggregate & { challengeId: string; viewCount: number }> = [];
  const outOfZone: CandidateTag[] = [];
  shortlist.forEach((tag, index) => {
    const result = sizeResults[index];
    if (result.status !== "fulfilled") {
      console.error(`Failed to size tag "${tag.name}":`, result.reason);
      outOfZone.push({ ...tag });
      return;
    }
    const { challengeId, viewCount } = result.value;
    if (viewCount >= TAG_ZONE_MIN && viewCount <= TAG_ZONE_MAX) {
      inZone.push({ ...tag, challengeId, viewCount });
    } else {
      outOfZone.push({
        ...tag,
        challengeId,
        viewCount,
        zone: viewCount < TAG_ZONE_MIN ? "too-small" : "too-big",
      });
    }
  });

  // Hop 2: pull recent videos for the top in-zone tags, under the same
  // views floor as the seed scans so discovery can't reintroduce
  // filtered-out videos
  const picks = inZone.slice(0, topK);
  const pullResults = await Promise.allSettled(
    picks.map((tag) => fetchTagPosts(tag.challengeId, POSTS_PER_PULL, minViews))
  );

  const expandedTags: DiscoveredTag[] = [];
  const hop2Harvest: HarvestedVideo[] = [];
  picks.forEach((tag, index) => {
    const result = pullResults[index];
    if (result.status !== "fulfilled") {
      console.error(`Failed to expand tag "${tag.name}":`, result.reason);
      return;
    }
    const tagHarvest = result.value.map(harvestVideoItem);
    hop2Harvest.push(...tagHarvest);

    const followerByVideo = new Map(
      tagHarvest.map((h) => [h.video.id, h.authorFollowerCount])
    );
    const topVideos = dedupeVideosById(tagHarvest.map((h) => h.video))
      .filter((v) => !isOwnVideo(v, ownHandle))
      .sort(
        (a, b) =>
          trendingScore(b, followerByVideo.get(b.id)) -
          trendingScore(a, followerByVideo.get(a.id))
      )
      .slice(0, MAX_VIDEOS_PER_EXPANDED_TAG);

    expandedTags.push({
      name: tag.name,
      challengeId: tag.challengeId,
      score: tag.score,
      occurrences: tag.occurrences,
      viewCount: tag.viewCount,
      topVideos,
    });
  });

  // Second-generation candidates: tags the meander found but didn't follow.
  // Sized out-of-zone tags come first since we know their size
  const gen2Exclude = new Set([...exclude, ...shortlist.map((t) => t.name)]);
  const gen2Tags = aggregateCoTags(hop2Harvest, gen2Exclude);
  const candidateTags = [...outOfZone, ...gen2Tags].slice(0, MAX_CANDIDATE_TAGS);

  // Pooled trending videos across both hops
  const followerByVideo = new Map<string, number | undefined>();
  for (const h of [...harvest, ...hop2Harvest]) {
    if (!followerByVideo.has(h.video.id)) {
      followerByVideo.set(h.video.id, h.authorFollowerCount);
    }
  }
  const trendingVideos = dedupeVideosById(
    [...harvest, ...hop2Harvest].map((h) => h.video)
  )
    .filter((v) => !isOwnVideo(v, ownHandle))
    .sort(
      (a, b) =>
        trendingScore(b, followerByVideo.get(b.id)) -
        trendingScore(a, followerByVideo.get(a.id))
    )
    .slice(0, MAX_TRENDING_VIDEOS);

  return { expandedTags, candidateTags, trendingVideos };
}
