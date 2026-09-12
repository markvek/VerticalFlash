import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rejectedTagsAfterEdit } from "@/lib/library-metadata";
import { LibraryRecoveryError, withLibraryEdit } from "@/lib/library-store";
import { ClipLibraryZ } from "@/lib/library-schema";
import { saveLibrary, scanLibrary } from "@/lib/library-store";

export async function GET() {
  try {
    const library = await scanLibrary();
    return NextResponse.json(ClipLibraryZ.parse(library));
  } catch (error) {
    console.error("Failed to load clip library:", error);
    return NextResponse.json(
      { error: error instanceof LibraryRecoveryError ? error.message : "Failed to load video library", recoveryRequired: error instanceof LibraryRecoveryError },
      { status: 500 }
    );
  }
}

const MetadataPatchZ = z.object({
  filename: z.string().min(1),
  date: z.union([z.string().datetime(), z.literal("").transform(() => null)]).nullable().optional(),
  tags: z.array(z.string()).optional(),
  rejected_tags: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  duration: z.number().nonnegative().nullable().optional(),
});

export async function POST(request: NextRequest) {
  return withLibraryEdit(async () => {
    try {
      const body = MetadataPatchZ.parse(await request.json());
      const { filename, tags } = body;

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
        ...body,
        ...(tags !== undefined && { rejected_tags: body.rejected_tags ?? rejectedTagsAfterEdit(library.videos[videoIndex], tags) }),
        updatedAt: new Date().toISOString(),
      };

      library.videos[videoIndex] = updated;
      library.lastUpdated = new Date().toISOString();

      await saveLibrary(library);

      return NextResponse.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Invalid metadata", details: error.message }, { status: 400 });
      console.error("Failed to update metadata:", error);
      return NextResponse.json(
        { error: error instanceof LibraryRecoveryError ? error.message : "Failed to update metadata", recoveryRequired: error instanceof LibraryRecoveryError },
        { status: 500 }
      );
    }
  });
}
