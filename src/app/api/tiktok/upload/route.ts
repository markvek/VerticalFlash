import { NextRequest, NextResponse } from "next/server";
import { execFileAsync } from "@/lib/ffmpeg";
import { promises as fs } from "fs";
import {
  getValidAccessToken,
  TikTokNotConnectedError,
} from "@/lib/tiktok-auth";
import { renderVideoPath } from "@/lib/render-remake";
import { recordPublish } from "@/lib/publish-store";
import { isValidVideoId } from "@/lib/video-id";

const INIT_URL =
  "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const STATUS_URL =
  "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

// TikTok chunking rules: files up to 64MB upload as ONE chunk whose
// chunk_size equals the file size; larger files use 5–64MB chunks where
// total_chunk_count = floor(video_size / chunk_size) and the final chunk
// absorbs the remainder.
const SINGLE_CHUNK_MAX = 64 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;

export const maxDuration = 300;

// One upload per video at a time (same pattern as the render route)
const inFlight = new Set<string>();

// Successful uploads append a publish record (best-effort — recordPublish
// never throws) so the published post can be matched back to this render
async function uploadSuccess(videoId: string, publishId: string, status: string) {
  await recordPublish({ videoId, publishId, status });
  return NextResponse.json({ success: true, publishId, status });
}

export async function POST(request: NextRequest) {
  // Drafts can't carry a caption — TikTok's inbox upload takes bytes only;
  // the user writes the caption in the TikTok app when posting
  let videoId = "";
  try {
    const body = await request.json();
    videoId = String(body?.videoId ?? "");
  } catch {
    // fall through to validation below
  }

  if (!videoId || !isValidVideoId(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  if (inFlight.has(videoId)) {
    return NextResponse.json(
      { error: "An upload for this video is already running" },
      { status: 409 }
    );
  }
  inFlight.add(videoId);

  try {
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken();
    } catch (error) {
      if (error instanceof TikTokNotConnectedError) {
        return NextResponse.json(
          { error: "not_connected", message: "Connect your TikTok account first" },
          { status: 401 }
        );
      }
      throw error;
    }

    const videoPath = renderVideoPath(videoId);
    let videoSize: number;
    try {
      videoSize = (await fs.stat(videoPath)).size;
    } catch {
      return NextResponse.json(
        { error: `No render found for video ${videoId} — render it first` },
        { status: 404 }
      );
    }

    // Sanity-check the render is portrait 9:16 before shipping it to TikTok
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        videoPath,
      ]);
      const [width, height] = stdout.trim().split(",").map(Number);
      if (width && height && Math.abs(width / height - 9 / 16) > 0.01) {
        return NextResponse.json(
          {
            error: `Render is ${width}x${height}, not 9:16 portrait — re-render before uploading`,
          },
          { status: 422 }
        );
      }
    } catch {
      // ffprobe unavailable — renders are produced at 1080x1920, proceed
    }

    const singleChunk = videoSize <= SINGLE_CHUNK_MAX;
    const chunkSize = singleChunk ? videoSize : CHUNK_SIZE;
    const totalChunks = singleChunk ? 1 : Math.floor(videoSize / CHUNK_SIZE);

    const initBody = {
      source_info: {
        source: "FILE_UPLOAD",
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunks,
      },
    };
    console.log("TikTok upload init:", JSON.stringify(initBody));

    const initRes = await fetch(INIT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initBody),
    });
    const initData = await initRes.json();
    if (!initRes.ok || initData?.error?.code !== "ok") {
      console.error(
        "TikTok init rejected:",
        JSON.stringify({ status: initRes.status, response: initData })
      );
      const code = initData?.error?.code || "";
      const msg = initData?.error?.message || `HTTP ${initRes.status}`;
      // A scope failure means the saved token predates the video.upload
      // grant — reconnecting mints a token with the new scope
      if (code === "scope_not_authorized" || /scope/i.test(msg)) {
        return NextResponse.json(
          {
            error:
              "Your TikTok connection is missing the upload permission — click disconnect, then Connect TikTok again and approve the video-posting permission. (Also confirm the Content Posting API product is added to the sandbox on developers.tiktok.com.)",
          },
          { status: 403 }
        );
      }
      return NextResponse.json(
        {
          error: `TikTok rejected the upload (${msg}) — video is ${(videoSize / 1024 / 1024).toFixed(1)}MB`,
        },
        { status: 502 }
      );
    }

    const { publish_id: publishId, upload_url: uploadUrl } = initData.data;

    // TikTok wants exactly total_chunk_count PUTs; the last chunk absorbs
    // the remainder, so compute ranges off the chunk index
    const file = await fs.open(videoPath, "r");
    try {
      for (let i = 0; i < totalChunks; i++) {
        const first = i * chunkSize;
        const last =
          i === totalChunks - 1 ? videoSize - 1 : first + chunkSize - 1;
        const length = last - first + 1;
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, first);

        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(length),
            "Content-Range": `bytes ${first}-${last}/${videoSize}`,
          },
          body: new Uint8Array(buffer),
        });
        if (!putRes.ok && putRes.status !== 201) {
          const text = await putRes.text().catch(() => "");
          throw new Error(
            `Chunk ${i + 1}/${totalChunks} failed (HTTP ${putRes.status}) ${text}`.trim()
          );
        }
      }
    } finally {
      await file.close();
    }

    // Poll until TikTok finishes ingesting the bytes we just sent
    let status = "PROCESSING_UPLOAD";
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch(STATUS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ publish_id: publishId }),
      });
      const statusData = await statusRes.json();
      status = statusData?.data?.status || status;
      if (status === "SEND_TO_USER_INBOX" || status === "PUBLISH_COMPLETE") {
        return uploadSuccess(videoId, publishId, status);
      }
      if (status === "FAILED") {
        return NextResponse.json(
          {
            error: `TikTok processing failed: ${statusData?.data?.fail_reason || "unknown reason"}`,
            publishId,
          },
          { status: 502 }
        );
      }
    }

    // Still processing — the draft usually lands shortly after
    return uploadSuccess(videoId, publishId, status);
  } catch (error) {
    console.error("TikTok upload failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  } finally {
    inFlight.delete(videoId);
  }
}
