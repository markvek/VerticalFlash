import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { fetchVideoDetail, harvestAppVideoItem } from "@/lib/tikhub";
import { DOWNLOADS_DIR } from "@/lib/paths";


export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get("videoId");
  const filename = request.nextUrl.searchParams.get("filename") || "video.mp4";

  if (!videoId || !/^\d+$/.test(videoId)) {
    return NextResponse.json({ error: "valid videoId required" }, { status: 400 });
  }

  const safeFilename = filename.replace(/[^\w.-]/g, "_");
  // The analyze route discovers files by `*_<videoId>.mp4` / `<videoId>.mp4`,
  // and the downloads listing hides dotfiles — fall back to a name that is
  // guaranteed discoverable if the requested one doesn't fit.
  const savedFilename =
    (safeFilename.endsWith(`_${videoId}.mp4`) ||
      safeFilename === `${videoId}.mp4`) &&
    !safeFilename.startsWith(".")
      ? safeFilename
      : `${videoId}.mp4`;

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

    // Buffer the whole video (TikToks are small) so the local copy is fully
    // on disk before the response resolves — the client chains the analyze
    // call off this request completing.
    const buffer = Buffer.from(await upstream.arrayBuffer());

    // Save a server-side copy so analysis can run without the user manually
    // moving the file. Best-effort: never fail the download over it.
    try {
      await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
      await fs.writeFile(join(DOWNLOADS_DIR, savedFilename), buffer);
    } catch (saveError) {
      console.error("Failed to save video copy:", saveError);
    }

    // Persist metadata alongside the download so later features (analysis)
    // can read it from disk. Best-effort: never fail the download over it.
    try {
      const harvested = harvestAppVideoItem(detail);
      const metadata = {
        ...harvested.video,
        authorFollowerCount: harvested.authorFollowerCount,
        musicId: harvested.musicId,
        musicTitle: harvested.musicTitle,
        musicAuthor: detail.music?.author,
        coTags: harvested.coTags,
        savedAt: new Date().toISOString(),
      };
      await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
      await fs.writeFile(
        join(DOWNLOADS_DIR, `${savedFilename}.metadata.json`),
        JSON.stringify(metadata, null, 2)
      );
    } catch (metaError) {
      console.error("Failed to write metadata sidecar:", metaError);
    }

    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${savedFilename}"`,
      "Content-Length": String(buffer.length),
      "X-Saved-Filename": savedFilename,
    });

    return new NextResponse(buffer, { headers });
  } catch (error) {
    console.error("proxy-video failed:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Download failed",
      },
      { status: 500 }
    );
  }
}
