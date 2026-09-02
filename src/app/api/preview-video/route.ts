import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { fetchVideoDetail } from "@/lib/tikhub";
import { DOWNLOADS_DIR } from "@/lib/paths";

// Dotfile dir: the downloads listing hides dotfiles, so cached previews
// never show up in the Downloads sidebar
const PREVIEW_CACHE_DIR = join(DOWNLOADS_DIR, ".preview-cache");

function mp4Response(buffer: Buffer) {
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": "inline",
      "Content-Length": String(buffer.length),
    },
  });
}

// Streams video bytes for the hover preview. TikTok CDN URLs can't be
// played from the browser (CORS locked to tiktok.com, and web-API URLs
// are session-bound), so the bytes must come from our origin.
export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get("videoId");

  if (!videoId || !/^\d+$/.test(videoId)) {
    return NextResponse.json({ error: "valid videoId required" }, { status: 400 });
  }

  // Already-downloaded videos are discoverable as `*_<id>.mp4` / `<id>.mp4`
  // (same convention as the analyze route) — serve those without a fetch
  try {
    const entries = await fs.readdir(DOWNLOADS_DIR);
    const existing = entries.find(
      (name) =>
        !name.startsWith(".") &&
        (name === `${videoId}.mp4` || name.endsWith(`_${videoId}.mp4`))
    );
    if (existing) {
      return mp4Response(await fs.readFile(join(DOWNLOADS_DIR, existing)));
    }
  } catch {
    // downloads dir may not exist yet
  }

  const cachePath = join(PREVIEW_CACHE_DIR, `${videoId}.mp4`);
  try {
    return mp4Response(await fs.readFile(cachePath));
  } catch {
    // not cached yet
  }

  try {
    const detail = await fetchVideoDetail(videoId);
    const playUrl = detail.video.play_addr.url_list[0];

    const upstream = await fetch(playUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `upstream fetch failed: ${upstream.status}` },
        { status: 502 }
      );
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());

    // Cache best-effort so re-hovers don't re-hit TikHub
    try {
      await fs.mkdir(PREVIEW_CACHE_DIR, { recursive: true });
      await fs.writeFile(cachePath, buffer);
    } catch (cacheError) {
      console.error("Failed to cache preview:", cacheError);
    }

    return mp4Response(buffer);
  } catch (error) {
    console.error("preview-video failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Preview failed" },
      { status: 500 }
    );
  }
}
