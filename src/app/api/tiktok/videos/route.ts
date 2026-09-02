import { NextResponse } from "next/server";
import {
  getValidAccessToken,
  readToken,
  tokenHasScope,
  TikTokNotConnectedError,
} from "@/lib/tiktok-auth";
import {
  fetchUserStats,
  listAllVideos,
  TikTokScopeError,
  type TikTokVideoStats,
} from "@/lib/tiktok-display";
import { readTikhubCache } from "@/lib/tikhub-cache";

const SCOPE_MISSING_MESSAGE =
  "Your TikTok connection predates the analytics permission — reconnect and " +
  "approve the video-list permission. (Also confirm video.list is enabled on " +
  "developers.tiktok.com.)";

export async function GET() {
  const token = await readToken();
  if (!token) {
    return NextResponse.json({ error: "not_connected" }, { status: 401 });
  }
  // Refresh grants never widen scopes, so a pre-change token can only be
  // fixed by reconnecting — catch it here instead of burning an API call
  if (!tokenHasScope(token, "video.list")) {
    return NextResponse.json(
      { error: "scope_missing", message: SCOPE_MISSING_MESSAGE },
      { status: 403 }
    );
  }

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken();
  } catch (error) {
    if (error instanceof TikTokNotConnectedError) {
      return NextResponse.json({ error: "not_connected" }, { status: 401 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Token refresh failed" },
      { status: 502 }
    );
  }

  try {
    const videos = await listAllVideos(accessToken);
    videos.sort((a, b) => b.createTime - a.createTime);
    const user = await fetchUserStats(accessToken);

    // Best-effort enrichment from the TikHub cache file (written by the
    // Sync button on /analytics) — stale data beats no data here
    const tikhubStats: Record<
      string,
      { completionRate?: number; newFollowersGained?: number }
    > = {};
    const tikhubCache = await readTikhubCache(true);
    for (const stats of tikhubCache?.videos || []) {
      tikhubStats[stats.aweme_id] = {
        completionRate: stats.completion_rate,
        newFollowersGained: stats.new_follower_cnt,
      };
    }

    // Merge TikHub stats into videos
    const enrichedVideos: TikTokVideoStats[] = videos.map((v) => ({
      ...v,
      ...tikhubStats[v.id],
    }));

    return NextResponse.json({
      videos: enrichedVideos,
      user,
      fetchedAt: Date.now(),
    });
  } catch (error) {
    if (error instanceof TikTokScopeError) {
      return NextResponse.json(
        { error: "scope_missing", message: SCOPE_MISSING_MESSAGE },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "TikTok request failed" },
      { status: 502 }
    );
  }
}
