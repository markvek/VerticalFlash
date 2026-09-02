import { NextRequest, NextResponse } from "next/server";
import { execFileAsync, ffmpegErrorResponse } from "@/lib/ffmpeg";
import { promises as fs } from "fs";
import { join } from "path";
import {
  generatedClipDir,
  isGeneratedClip,
} from "@/lib/generation-schema";

// Serves generated/<videoId>/<filename>; ?thumb=1 returns a cached jpeg
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string; filename: string }> }
) {
  const { videoId, filename: rawFilename } = await params;
  const filename = decodeURIComponent(rawFilename);

  if (!/^[\w-]+$/.test(videoId) || !isGeneratedClip(filename)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const dir = generatedClipDir(videoId);
  const filePath = join(dir, filename);

  try {
    if (request.nextUrl.searchParams.get("thumb") === "1") {
      const thumbsDir = join(dir, ".thumbs");
      const thumbPath = join(thumbsDir, `${filename}.jpg`);
      let thumb = await fs.readFile(thumbPath).catch(() => null);
      if (!thumb) {
        await fs.access(filePath);
        await fs.mkdir(thumbsDir, { recursive: true });
        await execFileAsync("ffmpeg", [
          "-y",
          "-ss",
          "0.5",
          "-i",
          filePath,
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
            filePath,
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
    }

    const fileBuffer = await fs.readFile(filePath);
    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fileBuffer.length.toString(),
        "Content-Disposition": `inline; filename="${filename}"`,
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    const missing = ffmpegErrorResponse(error);
    if (missing) return missing;
    console.error("Failed to serve generated clip:", error);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
