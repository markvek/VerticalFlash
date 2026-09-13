import { RenderManifestZ, type RenderManifest } from "@/lib/render-schema";
import { renderDeliveryError, renderBytesMatch, exportOperations } from "@/lib/render-revision";
import { renderManifestPath } from "@/lib/render-remake";
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { renderVideoPath } from "@/lib/render-remake";
import { isValidVideoId } from "@/lib/video-id";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  let claimed = false;
  try {
    if (!isValidVideoId(videoId)) {
      return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
    }

    if (exportOperations.has(videoId)) return NextResponse.json({ error: "An export or upload is running. Retry shortly." }, { status: 409 });
    exportOperations.add(videoId); claimed = true;
    const download = request.nextUrl.searchParams.get("download") === "1";
    let exportId = videoId;
    let manifest: RenderManifest | undefined;
    if (download) {
      manifest = RenderManifestZ.parse(JSON.parse(await fs.readFile(renderManifestPath(videoId), "utf8")));
      const error = await renderDeliveryError(manifest);
      if (error) return NextResponse.json({ error }, { status: 409 });
      exportId = manifest.exportId ?? videoId;
      const requestedExport = request.nextUrl.searchParams.get("exportId");
      if (requestedExport && requestedExport !== exportId) return NextResponse.json({ error: "The export changed. Refresh before downloading." }, { status: 409 });
    }
    const filePath = renderVideoPath(videoId);
    const fileBuffer = await fs.readFile(filePath).catch(() => null);
    if (!fileBuffer) {
      return NextResponse.json(
        { error: "No render found for this video" },
        { status: 404 }
      );
    }

    if (download && manifest && !renderBytesMatch(manifest, fileBuffer)) return NextResponse.json({ error: "Export bytes do not match the saved manifest. Export again before downloading." }, { status: 409 });

    // MP4 sanity check: ISO Media files carry "ftyp" at bytes 4-8
    if (fileBuffer.length < 12 || fileBuffer.toString("ascii", 4, 8) !== "ftyp") {
      return NextResponse.json(
        { error: "Render is not a valid mp4 — re-render the video" },
        { status: 415 }
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
        fileBuffer.length - 1
      );
      if (start > end || start >= fileBuffer.length) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileBuffer.length}` },
        });
      }
      return new NextResponse(new Uint8Array(fileBuffer.subarray(start, end + 1)), {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": (end - start + 1).toString(),
          "Content-Range": `bytes ${start}-${end}/${fileBuffer.length}`,
          "Accept-Ranges": "bytes",
        },
      });
    }

    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fileBuffer.length.toString(),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="remake-${videoId}-${exportId}.mp4"`,
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    console.error("Failed to serve render:", error);
    return NextResponse.json(
      { error: "Failed to load render" },
      { status: 500 }
    );
  } finally {
    if (claimed) exportOperations.delete(videoId);
  }
}
