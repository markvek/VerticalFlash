import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { resolveProjectFile } from "@/lib/download-files";


export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename: rawFilename } = await params;
    const filename = decodeURIComponent(rawFilename);

    // Prevent directory traversal
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 }
      );
    }

    const file = await resolveProjectFile(filename);
    if (!file) {
      return NextResponse.json(
        { error: "File not found" },
        { status: 404 }
      );
    }

    // Read the file
    const fileBuffer = await fs.readFile(file.path);

    // MP4 sanity check: ISO Media files carry "ftyp" at bytes 4-8.
    // Guards against mislabeled files (e.g. an HTML page saved as .mp4)
    if (fileBuffer.length < 12 || fileBuffer.toString("ascii", 4, 8) !== "ftyp") {
      return NextResponse.json(
        { error: "File is not a valid mp4 — likely a failed download" },
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

    // Return as video/mp4 with proper headers for streaming
    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fileBuffer.length.toString(),
        "Content-Disposition": `inline; filename="${filename}"`,
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    console.error("Failed to serve video:", error);
    return NextResponse.json(
      { error: "Failed to load video" },
      { status: 500 }
    );
  }
}
