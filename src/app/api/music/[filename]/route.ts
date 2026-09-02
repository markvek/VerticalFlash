import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { extname } from "path";
import { musicCoverPath, musicPath } from "@/lib/music-library";
import { isValidMusicFilename } from "@/lib/music-schema";

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

// Serves a library track (with Range support so <audio> can seek) or, with
// ?cover=1, its cover art.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename: rawFilename } = await params;
  const filename = decodeURIComponent(rawFilename);
  if (!isValidMusicFilename(filename)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  if (request.nextUrl.searchParams.get("cover")) {
    const cover = await fs.readFile(musicCoverPath(filename)).catch(() => null);
    if (!cover) {
      return NextResponse.json({ error: "No cover" }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(cover), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  const buffer = await fs.readFile(musicPath(filename)).catch(() => null);
  if (!buffer) {
    return NextResponse.json({ error: "Track not found" }, { status: 404 });
  }
  const mime = MIME_TYPES[extname(filename).toLowerCase()] ?? "audio/mpeg";

  const range = request.headers.get("range");
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? parseInt(match[1], 10) : 0;
    const end = Math.min(
      match?.[2] ? parseInt(match[2], 10) : buffer.length - 1,
      buffer.length - 1
    );
    if (start > end || start >= buffer.length) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${buffer.length}` },
      });
    }
    return new NextResponse(new Uint8Array(buffer.subarray(start, end + 1)), {
      status: 206,
      headers: {
        "Content-Type": mime,
        "Content-Length": (end - start + 1).toString(),
        "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": mime,
      "Content-Length": buffer.length.toString(),
      "Content-Disposition": `inline; filename="${filename}"`,
      "Accept-Ranges": "bytes",
    },
  });
}
