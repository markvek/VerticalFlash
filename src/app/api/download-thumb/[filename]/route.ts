import { NextRequest, NextResponse } from "next/server";
import { execFileAsync, ffmpegErrorResponse } from "@/lib/ffmpeg";
import { promises as fs } from "fs";
import { join } from "path";
import { extractVideoId } from "@/lib/video-id";
import { RENDERS_DIR } from "@/lib/paths";
import { resolveProjectFile } from "@/lib/download-files";

// Poster frame for a downloaded video (?source=original, default) or its
// remake render (?source=render). Cached as a jpg in a hidden .thumbs dir.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename: rawFilename } = await params;
  const filename = decodeURIComponent(rawFilename);

  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.startsWith(".")
  ) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const source = request.nextUrl.searchParams.get("source") ?? "original";

  let videoPath: string;
  let thumbsDir: string;
  let thumbPath: string;
  if (source === "render") {
    const videoId = extractVideoId(filename);
    if (!videoId) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }
    videoPath = join(RENDERS_DIR, `${videoId}.mp4`);
    thumbsDir = join(RENDERS_DIR, ".thumbs");
    thumbPath = join(thumbsDir, `${videoId}.jpg`);
  } else {
    const file = await resolveProjectFile(filename);
    if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });
    videoPath = file.path;
    thumbsDir = join(file.directory, ".thumbs");
    thumbPath = join(thumbsDir, `${filename}.jpg`);
  }

  try {
    const videoStat = await fs.stat(videoPath);

    // Renders are overwritten in place on re-render, so a cached thumb
    // older than its video is stale
    const thumbStat = await fs.stat(thumbPath).catch(() => null);
    let thumb =
      thumbStat && thumbStat.mtimeMs >= videoStat.mtimeMs
        ? await fs.readFile(thumbPath).catch(() => null)
        : null;

    if (!thumb) {
      await fs.mkdir(thumbsDir, { recursive: true });
      // Grab a frame 0.5s in (falls back to first frame on very short clips)
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss",
        "0.5",
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=-2:480",
        "-q:v",
        "4",
        thumbPath,
      ]).catch(() =>
        execFileAsync("ffmpeg", [
          "-y",
          "-i",
          videoPath,
          "-frames:v",
          "1",
          "-vf",
          "scale=-2:480",
          "-q:v",
          "4",
          thumbPath,
        ])
      );
      thumb = await fs.readFile(thumbPath);
    }

    return new NextResponse(new Uint8Array(thumb), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    const missing = ffmpegErrorResponse(error);
    if (missing) return missing;
    console.error("download thumbnail failed:", error);
    return NextResponse.json(
      { error: "Failed to generate thumbnail" },
      { status: 404 }
    );
  }
}
