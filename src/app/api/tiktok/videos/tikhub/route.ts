import { NextResponse } from "next/server";
import { getCreatorVideoAnalytics } from "@/lib/tikhub";
import { readTikhubCache, writeTikhubCache } from "@/lib/tikhub-cache";

const COOKIE_HELP =
  "Completion rate requires a TikTok Shop creator account — TikHub reads it " +
  "from the Shop creator dashboard, and regular accounts don't have one. " +
  "Once the account joins TikTok Shop: set TIKTOK_CREATOR_COOKIE in " +
  ".env.local (log into tiktok.com as the creator account, open DevTools → " +
  "Network, click any request to tiktok.com, copy the full `cookie` request " +
  "header value), restart the dev server, and sync again.";

// The endpoint takes a start date; 90 days covers this account's whole
// posting history while keeping the response small
function defaultStartDate(): string {
  const d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}-${d.getFullYear()}`;
}

export async function GET() {
  // Fresh cache wins — the Sync button is a no-op until the TTL lapses
  const cached = await readTikhubCache();
  if (cached) {
    return NextResponse.json({ ...cached, fromCache: true });
  }

  if (!process.env.TIKHUB_API_KEY) {
    return NextResponse.json(
      {
        error: "tikhub_config_missing",
        message: "TIKHUB_API_KEY not set in .env.local",
      },
      { status: 500 }
    );
  }

  // The cookie identifies which TikTok account to pull analytics for — it
  // must be a tiktok.com session cookie, not a tikhub.io one.
  const tiktokCookie = process.env.TIKTOK_CREATOR_COOKIE;
  if (!tiktokCookie) {
    return NextResponse.json(
      { error: "tikhub_auth_missing", message: COOKIE_HELP },
      { status: 403 }
    );
  }

  try {
    const videos = await getCreatorVideoAnalytics(
      tiktokCookie,
      defaultStartDate()
    );
    const entry = await writeTikhubCache(videos);
    return NextResponse.json({ ...entry, fromCache: false });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    if (/401|403|cookie|login|unauthorized/i.test(msg)) {
      return NextResponse.json(
        {
          error: "tikhub_auth_failed",
          message: `TikHub rejected the request (${msg}). Your tiktok.com cookie is likely expired or from the wrong site. ${COOKIE_HELP}`,
        },
        { status: 403 }
      );
    }

    if (/429|quota|rate/i.test(msg)) {
      const stale = await readTikhubCache(true);
      if (stale) {
        return NextResponse.json({
          ...stale,
          fromCache: true,
          stale: true,
          message: "TikHub rate limited — returning stale cache",
        });
      }
      return NextResponse.json(
        { error: "tikhub_rate_limited", message: msg },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: "tikhub_fetch_failed", message: msg },
      { status: 502 }
    );
  }
}
