import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { BENCHMARKS_DIR } from "@/lib/paths";
import { readBenchmarkRun } from "@/lib/benchmarks";
import { isValidVideoId } from "@/lib/video-id";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; variantId: string }> },
) {
  try {
    const { runId, variantId } = await params;
    const videoId = variantId;
    if (!/^[\w-]+$/.test(runId))
      return NextResponse.json({ error: "Invalid run" }, { status: 400 });
    const run = await readBenchmarkRun(runId);
    if (!run?.variants.some((v) => v.id === variantId && v.status === "ready"))
      return NextResponse.json({ error: "Preview not ready" }, { status: 404 });
    if (!isValidVideoId(videoId)) {
      return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
    }

    const filePath = join(BENCHMARKS_DIR, runId, `${variantId}.mp4`);
    const fileBuffer = await fs.readFile(filePath).catch(() => null);
    if (!fileBuffer) {
      return NextResponse.json(
        { error: "No render found for this video" },
        { status: 404 },
      );
    }

    // MP4 sanity check: ISO Media files carry "ftyp" at bytes 4-8
    if (
      fileBuffer.length < 12 ||
      fileBuffer.toString("ascii", 4, 8) !== "ftyp"
    ) {
      return NextResponse.json(
        { error: "Render is not a valid mp4 — re-render the video" },
        { status: 415 },
      );
    }

    // Honor Range requests — without 206 responses the <video> element
    // cannot seek (setting currentTime snaps back to 0)
    const range = request.headers.get("range");
    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      const start = match?.[1] ? parseInt(match[1], 10) : 0;
      const end = Math.min(
        match?.[2] ? parseInt(match[2], 10) : fileBuffer.length - 1,
        fileBuffer.length - 1,
      );
      if (start > end || start >= fileBuffer.length) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileBuffer.length}` },
        });
      }
      return new NextResponse(
        new Uint8Array(fileBuffer.subarray(start, end + 1)),
        {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": (end - start + 1).toString(),
            "Content-Range": `bytes ${start}-${end}/${fileBuffer.length}`,
            "Accept-Ranges": "bytes",
          },
        },
      );
    }

    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fileBuffer.length.toString(),
        "Content-Disposition": `inline; filename="remake-${videoId}.mp4"`,
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    console.error("Failed to serve render:", error);
    return NextResponse.json(
      { error: "Failed to load render" },
      { status: 500 },
    );
  }
}
