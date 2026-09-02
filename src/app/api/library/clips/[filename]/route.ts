import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { LIBRARY_DIR } from "@/lib/paths";
import { VIDEO_MIME_TYPES } from "@/lib/library-schema";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename: rawFilename } = await params;
    const filename = decodeURIComponent(rawFilename);

    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 }
      );
    }

    const filePath = join(LIBRARY_DIR, filename);
    const realPath = await fs.realpath(filePath).catch(() => null);
    const realLibraryDir = await fs.realpath(LIBRARY_DIR).catch(() => null);

    if (!realPath || !realLibraryDir || !realPath.startsWith(realLibraryDir)) {
      return NextResponse.json(
        { error: "Invalid file path" },
        { status: 400 }
      );
    }

    const fileBuffer = await fs.readFile(filePath);

    const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
    const mimeType = VIDEO_MIME_TYPES[ext] || "video/mp4";

    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": mimeType,
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
