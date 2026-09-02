// Thin client for the TikTok Display API — reads the connected account's own
// published videos and profile stats. Requires the video.list scope (and
// user.info.stats for follower/likes totals).

const VIDEO_LIST_URL = "https://open.tiktokapis.com/v2/video/list/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";

const VIDEO_FIELDS = [
  "id",
  "title",
  "create_time",
  "cover_image_url",
  "share_url",
  "view_count",
  "like_count",
  "comment_count",
  "share_count",
  "duration",
].join(",");

const USER_FIELDS = [
  "display_name",
  "avatar_url_100",
  "follower_count",
  "likes_count",
  "video_count",
].join(",");

export interface TikTokVideoStats {
  id: string;
  title: string;
  // Unix seconds
  createTime: number;
  coverImageUrl: string;
  shareUrl: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  // Seconds
  duration: number;
  // From TikHub: average percentage of video watched (0–100)
  completionRate?: number;
  // From TikHub: new followers gained from this video
  newFollowersGained?: number;
}

export interface TikTokUserStats {
  displayName: string;
  avatarUrl?: string;
  followerCount?: number;
  likesCount?: number;
  videoCount?: number;
}

// The saved token predates the video.list grant — only a reconnect fixes it
export class TikTokScopeError extends Error {
  constructor(message = "scope_not_authorized") {
    super(message);
    this.name = "TikTokScopeError";
  }
}

interface RawVideo {
  id?: string;
  title?: string;
  create_time?: number;
  cover_image_url?: string;
  share_url?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  duration?: number;
}

// video.list pages are capped at 20; a creator with more than 200 posts is
// out of scope for this tool, and the cap guards against a cursor that
// never terminates
const MAX_PAGES = 10;

export async function listAllVideos(
  accessToken: string
): Promise<TikTokVideoStats[]> {
  const videos: TikTokVideoStats[] = [];
  let cursor: number | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(`${VIDEO_LIST_URL}?fields=${VIDEO_FIELDS}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_count: 20,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    });
    // TikTok reports failures with HTTP 200 + a non-"ok" error envelope,
    // so the envelope check is load-bearing
    const data = await res.json();
    if (!res.ok || data?.error?.code !== "ok") {
      const code = data?.error?.code || "";
      const msg = data?.error?.message || `HTTP ${res.status}`;
      if (code === "scope_not_authorized" || /scope/i.test(msg)) {
        throw new TikTokScopeError(msg);
      }
      throw new Error(`TikTok video list failed: ${code || msg} ${msg}`);
    }

    for (const v of (data.data?.videos || []) as RawVideo[]) {
      videos.push({
        id: v.id || "",
        title: v.title || "",
        createTime: v.create_time || 0,
        coverImageUrl: v.cover_image_url || "",
        shareUrl: v.share_url || "",
        viewCount: v.view_count ?? 0,
        likeCount: v.like_count ?? 0,
        commentCount: v.comment_count ?? 0,
        shareCount: v.share_count ?? 0,
        duration: v.duration ?? 0,
      });
    }

    if (!data.data?.has_more) break;
    cursor = data.data.cursor;
  }

  return videos;
}

// Best-effort profile stats; callers treat null as "no header, list still
// works" (e.g. token minted without user.info.stats)
export async function fetchUserStats(
  accessToken: string
): Promise<TikTokUserStats | null> {
  try {
    const res = await fetch(`${USER_INFO_URL}?fields=${USER_FIELDS}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok || data?.error?.code !== "ok") return null;
    const u = data.data?.user;
    if (!u?.display_name) return null;
    return {
      displayName: u.display_name,
      avatarUrl: u.avatar_url_100,
      followerCount: u.follower_count,
      likesCount: u.likes_count,
      videoCount: u.video_count,
    };
  } catch {
    return null;
  }
}
