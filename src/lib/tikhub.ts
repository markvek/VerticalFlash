const TIKHUB_BASE_URL = "https://api.tikhub.io";

interface TikHubResponse<T> {
  code: number;
  message?: string;
  data: T;
}

interface TagDetail {
  challengeId: string;
  challengeName: string;
  videoCount: number;
  viewCount: number;
}

// Raw shape returned by /web/fetch_tag_detail
interface TagDetailRaw {
  challengeInfo: {
    challenge: {
      id: string;
      title: string;
      stats: {
        videoCount: number;
        viewCount: number;
      };
    };
  };
}

interface VideoItem {
  id: string;
  desc: string;
  createTime: number;
  video: {
    cover: string;
    playAddr: string;
    duration: number;
    downloadAddr?: string;
    bitrateInfo?: Array<{ PlayAddr?: { UrlList?: string[] } }>;
  };
  author: {
    uniqueId: string;
    nickname: string;
    avatarThumb: string;
  };
  stats: {
    playCount: number;
    diggCount: number;
    commentCount: number;
    shareCount: number;
  };
  challenges?: Array<{ id?: string; title?: string }>;
  textExtra?: Array<{ hashtagName?: string; type?: number }>;
  authorStats?: {
    followerCount?: number;
    heartCount?: number;
    videoCount?: number;
  };
  music?: {
    id?: string;
    title?: string;
    authorName?: string;
    original?: boolean;
  };
}

interface TagPostsData {
  itemList: VideoItem[];
  hasMore: boolean;
  cursor: string;
}

// App-API item shape returned by /app/v3/fetch_video_search_result
interface AppVideoItem {
  aweme_id: string;
  desc: string;
  create_time: number;
  video: {
    cover: { url_list: string[] };
    play_addr: { url_list: string[] };
    duration: number; // milliseconds
  };
  author: {
    unique_id: string;
    nickname: string;
    avatar_thumb: { url_list: string[] };
    follower_count?: number;
  };
  statistics: {
    play_count: number;
    digg_count: number;
    comment_count: number;
    share_count: number;
  };
  text_extra?: Array<{
    hashtag_name?: string;
    hashtag_id?: string;
    type?: number;
  }>;
  cha_list?: Array<{ cid?: string; cha_name?: string }> | null;
  music?: AppMusicInfo | null;
}

// TikTok music object as the app API returns it (on posts as `music`, and
// from /app/v3/fetch_music_detail as `music_info`). Verified against a
// live fetch_one_video payload: play_url.url_list holds direct MP3 URLs
// (GET only — HEAD returns 503), cover_* are HEIC images.
export interface AppMusicInfo {
  id?: string | number;
  id_str?: string;
  title?: string;
  author?: string;
  owner_handle?: string;
  owner_nickname?: string;
  // Seconds (integer); duration_high_precision carries the exact value
  duration?: number;
  duration_high_precision?: { duration_precision?: number };
  is_original_sound?: boolean;
  play_url?: { url_list?: string[] } | null;
  cover_medium?: { url_list?: string[] } | null;
  cover_large?: { url_list?: string[] } | null;
}

interface SearchVideoData {
  search_item_list: Array<{ aweme_info: AppVideoItem }>;
  has_more: number;
  cursor: number;
}

interface UserProfile {
  user: {
    uniqueId: string;
    nickname: string;
    avatarLarger: string;
    signature: string;
    verified: boolean;
    secUid: string;
  };
  stats: {
    followerCount: number;
    followingCount: number;
    heart: number;
    heartCount: number;
    videoCount: number;
    diggCount: number;
  };
}

// Raw shape returned by /web/fetch_user_profile
interface UserProfileRaw {
  userInfo: UserProfile;
}

async function tikhubFetch<T>(
  endpoint: string,
  params: Record<string, string | number>
): Promise<T> {
  const apiKey = process.env.TIKHUB_API_KEY;
  if (!apiKey) {
    throw new Error("TIKHUB_API_KEY is not configured");
  }

  const url = new URL(`${TIKHUB_BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, String(value));
  });

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    // TikHub error responses carry details in { detail: { message } }
    let detail = "";
    try {
      const errJson = (await response.json()) as {
        detail?: { message?: string };
      };
      detail = errJson.detail?.message || "";
    } catch {
      // body wasn't JSON; fall through with status only
    }
    throw new Error(
      `TikHub API error: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`
    );
  }

  const json = (await response.json()) as TikHubResponse<T>;

  // TikHub uses HTTP-style codes in the body: 200 means success
  if (json.code !== 200) {
    throw new Error(`TikHub API error: ${json.message || `code ${json.code}`}`);
  }

  return json.data;
}

export async function fetchTagDetail(tagName: string): Promise<TagDetail> {
  // Strip # symbol if present
  const cleanTag = tagName.replace(/^#/, "");

  const data = await tikhubFetch<TagDetailRaw>(
    "/api/v1/tiktok/web/fetch_tag_detail",
    { tag_name: cleanTag }
  );

  const challenge = data.challengeInfo?.challenge;
  if (!challenge?.id) {
    throw new Error(`Hashtag "${tagName}" not found`);
  }

  return {
    challengeId: challenge.id,
    challengeName: challenge.title,
    videoCount: challenge.stats?.videoCount || 0,
    viewCount: challenge.stats?.viewCount || 0,
  };
}

// TikHub's search/post endpoints expose no server-side filters for views or
// duration (search takes only sort_type/publish_time/region), so every scan
// pages through results and filters locally. The page cap keeps a sparse
// niche from running up unbounded API calls.
const FILTER_PAGE_SIZE = 30;
const FILTER_MAX_PAGES = 5;

// Clips longer than this can't be remixed into short-form output, so no
// scan ever surfaces them. Videos with no duration metadata (photo-mode
// posts) are dropped too.
const MAX_DURATION_SECONDS = 25;

function passesWebFilters(item: VideoItem, minPlayCount: number): boolean {
  const duration = item.video?.duration || 0; // seconds
  if (duration <= 0 || duration > MAX_DURATION_SECONDS) return false;
  return (item.stats?.playCount || 0) >= minPlayCount;
}

function passesAppFilters(item: AppVideoItem, minPlayCount: number): boolean {
  const duration = item.video?.duration || 0; // milliseconds
  if (duration <= 0 || duration > MAX_DURATION_SECONDS * 1000) return false;
  return (item.statistics?.play_count || 0) >= minPlayCount;
}

async function collectFilteredPages<TData, TItem>(opts: {
  fetchPage: (cursor: string | number) => Promise<TData>;
  items: (data: TData) => TItem[];
  next: (data: TData) => { hasMore: boolean; cursor: string | number };
  passes: (item: TItem) => boolean;
  count: number;
}): Promise<TItem[]> {
  const matches: TItem[] = [];
  let cursor: string | number = 0;
  for (let page = 0; page < FILTER_MAX_PAGES; page++) {
    const data = await opts.fetchPage(cursor);
    matches.push(...opts.items(data).filter(opts.passes));
    const next = opts.next(data);
    if (matches.length >= opts.count || !next.hasMore) break;
    cursor = next.cursor;
  }
  return matches.slice(0, opts.count);
}

export async function fetchTagPosts(
  challengeId: string,
  count: number = 10,
  minPlayCount: number = 0
): Promise<VideoItem[]> {
  return collectFilteredPages<TagPostsData, VideoItem>({
    fetchPage: (cursor) =>
      tikhubFetch("/api/v1/tiktok/web/fetch_tag_post", {
        challengeID: challengeId,
        count: FILTER_PAGE_SIZE,
        cursor,
      }),
    items: (data) => data.itemList || [],
    next: (data) => ({
      hasMore: Boolean(data.hasMore && data.cursor),
      cursor: data.cursor,
    }),
    passes: (item) => passesWebFilters(item, minPlayCount),
    count,
  });
}

export async function fetchSearchVideos(
  keyword: string,
  count: number = 10,
  minPlayCount: number = 0
): Promise<AppVideoItem[]> {
  // The /web/fetch_search_video endpoint currently 400s upstream,
  // so we use the app-API search instead
  return collectFilteredPages<SearchVideoData, AppVideoItem>({
    // sort_type 1 = most liked; relevance order rarely surfaces enough
    // 1M+ videos within the page cap. Plain duration-only scans keep
    // relevance order.
    fetchPage: (offset) =>
      tikhubFetch("/api/v1/tiktok/app/v3/fetch_video_search_result", {
        keyword,
        offset,
        count: FILTER_PAGE_SIZE,
        ...(minPlayCount > 0 ? { sort_type: 1 } : {}),
      }),
    items: (data) =>
      (data.search_item_list || [])
        .map((item) => item.aweme_info)
        .filter(Boolean),
    next: (data) => ({ hasMore: Boolean(data.has_more), cursor: data.cursor }),
    passes: (item) => passesAppFilters(item, minPlayCount),
    count,
  });
}

export async function fetchUserProfile(uniqueId: string): Promise<UserProfile> {
  // Strip @ symbol if present
  const cleanId = uniqueId.replace(/^@/, "");

  const data = await tikhubFetch<UserProfileRaw>(
    "/api/v1/tiktok/web/fetch_user_profile",
    { uniqueId: cleanId }
  );

  if (!data.userInfo?.user?.uniqueId) {
    throw new Error(`User "${uniqueId}" not found`);
  }

  return data.userInfo;
}

// Raw shape returned by /app/v3/fetch_one_video
interface OneVideoData {
  aweme_detail?: AppVideoItem;
  aweme_details?: AppVideoItem[];
}

// Fetch full video detail via the app API. Web-API playAddr URLs are
// session-bound (403 outside the browser that requested them), but
// app-API play_addr URLs download from anywhere — and the same response
// carries the metadata we persist alongside downloads.
export async function fetchVideoDetail(awemeId: string): Promise<AppVideoItem> {
  const data = await tikhubFetch<OneVideoData>(
    "/api/v1/tiktok/app/v3/fetch_one_video",
    { aweme_id: awemeId }
  );

  const detail = data.aweme_detail || data.aweme_details?.[0];
  if (!detail?.video?.play_addr?.url_list?.[0]) {
    throw new Error(`No playable URL found for video ${awemeId}`);
  }
  return detail;
}

// Raw shape returned by /app/v3/fetch_music_detail
interface MusicDetailData {
  music_info?: AppMusicInfo;
}

// Full music detail for a TikTok music/sound id (from a tiktok.com/music/…
// link). Same object shape as a post's `music`, including play_url.
export async function fetchMusicDetail(musicId: string): Promise<AppMusicInfo> {
  const data = await tikhubFetch<MusicDetailData>(
    "/api/v1/tiktok/app/v3/fetch_music_detail",
    { music_id: musicId }
  );
  const info = data.music_info;
  if (!info || (info.id == null && !info.id_str)) {
    throw new Error(`Music ${musicId} not found`);
  }
  return info;
}

export async function fetchUserPosts(
  secUid: string,
  count: number = 15,
  minPlayCount: number = 0
): Promise<VideoItem[]> {
  return collectFilteredPages<TagPostsData, VideoItem>({
    fetchPage: (cursor) =>
      tikhubFetch("/api/v1/tiktok/web/fetch_user_post", {
        secUid,
        count: FILTER_PAGE_SIZE,
        cursor,
      }),
    items: (data) => data.itemList || [],
    next: (data) => ({
      hasMore: Boolean(data.hasMore && data.cursor),
      cursor: data.cursor,
    }),
    passes: (item) => passesWebFilters(item, minPlayCount),
    count,
  });
}

// Simplified types for the frontend
export interface Video {
  id: string;
  caption: string;
  thumbnail: string;
  playCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  authorHandle: string;
  authorName: string;
  authorAvatar: string;
  duration: number;
  createdAt: number;
  playAddr?: string; // Video file URL for downloading
}

export interface HashtagData {
  name: string;
  videoCount: number;
  viewCount: number;
  topVideos: Video[];
}

export interface KeywordData {
  term: string;
  videos: Video[];
}

export interface CompetitorData {
  handle: string;
  nickname: string;
  avatar: string;
  followers: number;
  following: number;
  likes: number;
  videoCount: number;
  bio: string;
  verified: boolean;
}

// A co-occurring hashtag found on a harvested video
export interface CoTag {
  name: string; // normalized: lowercase, no '#'
  id?: string; // challenge id when known; kept as string (ids exceed safe ints)
}

// A video plus the expansion edges its raw payload carried
export interface HarvestedVideo {
  video: Video;
  coTags: CoTag[];
  authorFollowerCount?: number;
  musicId?: string;
  musicTitle?: string;
}

export interface DiscoveredTag {
  name: string; // no leading '#'
  challengeId: string;
  score: number;
  occurrences: number; // distinct hop-1 videos carrying the tag
  viewCount: number; // lifetime tag views (from size lookup)
  topVideos: Video[];
}

export interface CandidateTag {
  name: string;
  challengeId?: string;
  score: number;
  occurrences: number;
  viewCount?: number; // only set for size-checked tags
  zone?: "in" | "too-small" | "too-big";
}

export interface DiscoveryData {
  expandedTags: DiscoveredTag[];
  candidateTags: CandidateTag[];
  trendingVideos: Video[];
}

export interface ScanResult {
  errors?: string[];
  hashtags: HashtagData[];
  keywords: KeywordData[];
  competitors: CompetitorData[];
  discovered?: DiscoveryData;
}

// Transform TikHub video to our simplified Video type
function transformVideo(item: VideoItem): Video {
  return {
    id: item.id,
    caption: item.desc,
    thumbnail: item.video?.cover || "",
    playCount: item.stats?.playCount || 0,
    likeCount: item.stats?.diggCount || 0,
    commentCount: item.stats?.commentCount || 0,
    shareCount: item.stats?.shareCount || 0,
    authorHandle: item.author?.uniqueId || "",
    authorName: item.author?.nickname || "",
    authorAvatar: item.author?.avatarThumb || "",
    duration: item.video?.duration || 0,
    createdAt: item.createTime || 0,
    playAddr:
      item.video?.playAddr ||
      item.video?.downloadAddr ||
      item.video?.bitrateInfo?.[0]?.PlayAddr?.UrlList?.[0],
  };
}

export interface HashtagScan {
  data: HashtagData;
  harvest: HarvestedVideo[];
}

export interface KeywordScan {
  data: KeywordData;
  harvest: HarvestedVideo[];
}

export interface CompetitorScan {
  data: CompetitorData;
  harvest: HarvestedVideo[];
}

export async function scanHashtag(
  tagName: string,
  minViews: number = 0
): Promise<HashtagScan> {
  const detail = await fetchTagDetail(tagName);
  const posts = await fetchTagPosts(detail.challengeId, 10, minViews);
  const harvest = posts.map(harvestVideoItem);

  return {
    data: {
      name: tagName.startsWith("#") ? tagName : `#${tagName}`,
      videoCount: detail.videoCount,
      viewCount: detail.viewCount,
      topVideos: harvest.map((h) => h.video),
    },
    harvest,
  };
}

function normalizeTagName(raw: string): string {
  return raw.replace(/^#/, "").trim().toLowerCase();
}

// Merge co-tag sources, deduping by name and preferring entries that carry an id
function mergeCoTags(entries: CoTag[]): CoTag[] {
  const byName = new Map<string, CoTag>();
  for (const entry of entries) {
    if (!entry.name) continue;
    const existing = byName.get(entry.name);
    if (!existing || (!existing.id && entry.id)) {
      byName.set(entry.name, entry);
    }
  }
  return [...byName.values()];
}

export function harvestVideoItem(item: VideoItem): HarvestedVideo {
  const coTags = mergeCoTags([
    ...(item.challenges || []).map((c) => ({
      name: normalizeTagName(c.title || ""),
      id: c.id,
    })),
    ...(item.textExtra || [])
      .filter((t) => t.type === 1 && t.hashtagName)
      .map((t) => ({ name: normalizeTagName(t.hashtagName!) })),
  ]);

  return {
    video: transformVideo(item),
    coTags,
    authorFollowerCount: item.authorStats?.followerCount,
    musicId: item.music?.id,
    musicTitle: item.music?.title,
  };
}

export function harvestAppVideoItem(item: AppVideoItem): HarvestedVideo {
  const coTags = mergeCoTags([
    ...(item.text_extra || [])
      .filter((t) => t.type === 1 && t.hashtag_name)
      .map((t) => ({
        name: normalizeTagName(t.hashtag_name!),
        id: t.hashtag_id,
      })),
    ...(item.cha_list || []).map((c) => ({
      name: normalizeTagName(c.cha_name || ""),
      id: c.cid,
    })),
  ]);

  return {
    video: transformAppVideo(item),
    coTags,
    authorFollowerCount: item.author?.follower_count,
    musicId: item.music?.id != null ? String(item.music.id) : undefined,
    musicTitle: item.music?.title,
  };
}

// Transform app-API video (snake_case, ms durations) to our Video type
function transformAppVideo(item: AppVideoItem): Video {
  return {
    id: item.aweme_id,
    caption: item.desc,
    thumbnail: item.video?.cover?.url_list?.[0] || "",
    playCount: item.statistics?.play_count || 0,
    likeCount: item.statistics?.digg_count || 0,
    commentCount: item.statistics?.comment_count || 0,
    shareCount: item.statistics?.share_count || 0,
    authorHandle: item.author?.unique_id || "",
    authorName: item.author?.nickname || "",
    authorAvatar: item.author?.avatar_thumb?.url_list?.[0] || "",
    duration: Math.round((item.video?.duration || 0) / 1000),
    createdAt: item.create_time || 0,
    playAddr: item.video?.play_addr?.url_list?.[0],
  };
}

export async function scanKeyword(
  keyword: string,
  minViews: number = 0
): Promise<KeywordScan> {
  const items = await fetchSearchVideos(keyword, 10, minViews);
  const harvest = items.map(harvestAppVideoItem);

  return {
    data: {
      term: keyword,
      videos: harvest.map((h) => h.video),
    },
    harvest,
  };
}

export async function scanCompetitor(
  handle: string,
  minViews: number = 0
): Promise<CompetitorScan> {
  const profile = await fetchUserProfile(handle);

  // Recent posts feed the expansion step; a failure here shouldn't
  // sink the profile result
  let harvest: HarvestedVideo[] = [];
  if (profile.user.secUid) {
    try {
      const posts = await fetchUserPosts(profile.user.secUid, 15, minViews);
      harvest = posts.map(harvestVideoItem);
    } catch (error) {
      console.error(`Failed to fetch posts for "${handle}":`, error);
    }
  }

  return {
    data: {
      handle: profile.user.uniqueId,
      nickname: profile.user.nickname,
      avatar: profile.user.avatarLarger,
      followers: profile.stats.followerCount,
      following: profile.stats.followingCount,
      likes: profile.stats.heartCount,
      videoCount: profile.stats.videoCount,
      bio: profile.user.signature,
      verified: profile.user.verified,
    },
    harvest,
  };
}

// Creator analytics via TikHub's TikTok-Creator API
// (POST /api/v1/tiktok/creator/get_video_list_analytics). Auth is two-part:
// the TikHub API key goes in the Bearer header, and the creator's own
// tiktok.com session cookie goes in the request body — the cookie is what
// identifies the account; there is no creator_id parameter. Per TikHub's
// docs the endpoint is built for TikTok Shop creator accounts.
export interface CreatorVideoStats {
  aweme_id: string;
  title?: string;
  // Average percentage of the video watched, normalized to 0–100
  completion_rate?: number;
  // Views
  vv_cnt?: number;
  // Followers gained from this video
  new_follower_cnt?: number;
  like_cnt?: number;
  comment_cnt?: number;
  share_cnt?: number;
  // Unix seconds
  publish_time?: number;
  duration?: number;
}

interface CreatorTimedListItem {
  video_meta?: {
    item_id?: string | number;
    name?: string;
    publish_time?: number;
    duration?: number;
  };
  completion_rate?: number | string;
  vv_cnt?: number | string;
  new_follower_cnt?: number | string;
  like_cnt?: number | string;
  comment_cnt?: number | string;
  share_cnt?: number | string;
}

interface CreatorVideoListRaw {
  segments?: Array<{
    list_control?: {
      next_pagination?: {
        has_more?: boolean;
        total_page?: number;
        total_count?: number;
      };
    };
    timed_lists?: CreatorTimedListItem[];
  }>;
}

function toNum(v: number | string | undefined | null): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

export async function getCreatorVideoAnalytics(
  tiktokCookie: string,
  startDate: string
): Promise<CreatorVideoStats[]> {
  const apiKey = process.env.TIKHUB_API_KEY;
  if (!apiKey) {
    throw new Error("TIKHUB_API_KEY is not configured");
  }

  // Stats arrive per time period, so one video can appear in several
  // timed_lists — accumulate counts and view-weight the completion rate
  const byId = new Map<
    string,
    CreatorVideoStats & { completionWeight: number; completionSum: number }
  >();

  for (let page = 0; page < 5; page++) {
    const res = await fetch(
      `${TIKHUB_BASE_URL}/api/v1/tiktok/creator/get_video_list_analytics`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cookie: tiktokCookie,
          start_date: startDate,
          page,
        }),
      }
    );

    if (!res.ok) {
      let detail = "";
      try {
        // detail can be a string, {message}, or a FastAPI validation array
        const errJson = (await res.json()) as {
          detail?: string | { message?: string } | Array<{ msg?: string }>;
        };
        if (typeof errJson.detail === "string") {
          detail = errJson.detail;
        } else if (Array.isArray(errJson.detail)) {
          detail = errJson.detail
            .map((d) => d.msg)
            .filter(Boolean)
            .join("; ");
        } else {
          detail = errJson.detail?.message || "";
        }
      } catch {
        // body wasn't JSON; fall through with status only
      }
      throw new Error(
        `TikHub creator analytics error: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`
      );
    }

    const json = (await res.json()) as TikHubResponse<CreatorVideoListRaw>;
    if (json.code !== 200) {
      throw new Error(
        `TikHub creator analytics error: ${json.message || `code ${json.code}`}`
      );
    }

    let pageItems = 0;
    let hasMore = false;
    for (const seg of json.data?.segments || []) {
      for (const item of seg.timed_lists || []) {
        const id = item.video_meta?.item_id;
        if (id === undefined || id === null) continue;
        pageItems++;
        const key = String(id);
        const views = toNum(item.vv_cnt) ?? 0;
        // completion_rate comes back as a 0–1 fraction
        const rawCompletion = toNum(item.completion_rate);
        const existing = byId.get(key) || {
          aweme_id: key,
          title: item.video_meta?.name,
          publish_time: toNum(item.video_meta?.publish_time),
          duration: toNum(item.video_meta?.duration),
          vv_cnt: 0,
          new_follower_cnt: 0,
          like_cnt: 0,
          comment_cnt: 0,
          share_cnt: 0,
          completionWeight: 0,
          completionSum: 0,
        };
        existing.vv_cnt = (existing.vv_cnt || 0) + views;
        existing.new_follower_cnt =
          (existing.new_follower_cnt || 0) + (toNum(item.new_follower_cnt) ?? 0);
        existing.like_cnt = (existing.like_cnt || 0) + (toNum(item.like_cnt) ?? 0);
        existing.comment_cnt =
          (existing.comment_cnt || 0) + (toNum(item.comment_cnt) ?? 0);
        existing.share_cnt =
          (existing.share_cnt || 0) + (toNum(item.share_cnt) ?? 0);
        if (rawCompletion !== undefined) {
          const weight = views > 0 ? views : 1;
          existing.completionSum += rawCompletion * weight;
          existing.completionWeight += weight;
        }
        byId.set(key, existing);
      }
      if (seg.list_control?.next_pagination?.has_more) hasMore = true;
    }

    if (pageItems === 0 || !hasMore) break;
  }

  return Array.from(byId.values()).map(
    ({ completionWeight, completionSum, ...video }) => ({
      ...video,
      completion_rate:
        completionWeight > 0
          ? (completionSum / completionWeight) * 100
          : undefined,
    })
  );
}
