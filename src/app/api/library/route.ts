import { NextRequest, NextResponse } from "next/server";
import { ClipLibraryZ } from "@/lib/library-schema";
import { saveLibrary, scanLibrary } from "@/lib/library-store";

export async function GET() {
  try {
    const library = await scanLibrary();
    return NextResponse.json(ClipLibraryZ.parse(library));
  } catch (error) {
    console.error("Failed to load clip library:", error);
    return NextResponse.json(
      { error: "Failed to load video library" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filename, date, tags, description, source, duration } = body;

    if (!filename || typeof filename !== "string") {
      return NextResponse.json(
        { error: "filename is required" },
        { status: 400 }
      );
    }

    const library = await scanLibrary();
    const videoIndex = library.videos.findIndex((v) => v.filename === filename);

    if (videoIndex === -1) {
      return NextResponse.json(
        { error: "Video not found" },
        { status: 404 }
      );
    }

    const updated = {
      ...library.videos[videoIndex],
      ...(date && { date }),
      ...(tags !== undefined && { tags: Array.isArray(tags) ? tags : [] }),
      ...(description && { description }),
      ...(source && { source }),
      ...(duration !== undefined && {
        duration: typeof duration === "number" ? duration : undefined,
      }),
      updatedAt: new Date().toISOString(),
    };

    library.videos[videoIndex] = updated;
    library.lastUpdated = new Date().toISOString();

    await saveLibrary(library);

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Failed to update metadata:", error);
    return NextResponse.json(
      { error: "Failed to update metadata" },
      { status: 500 }
    );
  }
}
