import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { LIBRARY_DIR, LIBRARY_THUMBS_DIR } from "@/lib/paths";
import { ensureFfmpeg, execFileAsync, ffmpegErrorResponse } from "@/lib/ffmpeg";

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

  const videoPath = join(LIBRARY_DIR, filename);
  const thumbPath = join(LIBRARY_THUMBS_DIR, `${filename}.jpg`);

  try {
    let thumb = await fs.readFile(thumbPath).catch(() => null);

    if (!thumb) {
      await fs.access(videoPath);
      await ensureFfmpeg();
      await fs.mkdir(LIBRARY_THUMBS_DIR, { recursive: true });
      // Grab a frame 0.5s in (falls back to first frame on very short clips)
      // and scale to timeline-thumbnail size
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss",
        "0.5",
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=-2:192",
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
          "scale=-2:192",
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
    console.error("thumbnail failed:", error);
    return NextResponse.json(
      { error: "Failed to generate thumbnail" },
      { status: 404 }
    );
  }
}
