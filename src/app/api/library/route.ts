import { beginActivity, finishActivity } from "@/lib/workflow-activity";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ClipLibraryZ, clipTags } from "@/lib/library-schema";
import { loadLibrary, saveLibrary, scanLibrary, withLibraryLock, restoreLibraryBackup } from "@/lib/library-store";

export async function GET() {
  try {
    const library = await scanLibrary();
    return NextResponse.json(ClipLibraryZ.parse(library));
  } catch (error) {
    console.error("Failed to load clip library:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load video library" },
      { status: error instanceof z.ZodError ? 400 : 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (body.action === "restore_backup") { await restoreLibraryBackup(); return NextResponse.json({ restored: true }); }
    const { filename, ...changes } = z.object({
      filename: z.string().min(1), date: z.string().datetime().nullable().optional(),
      tags: z.array(z.string().trim().min(1)).optional(), description: z.string().nullable().optional(),
      source: z.string().nullable().optional(), duration: z.number().positive().nullable().optional(),
      spoken_text: z.string().optional(),
    }).parse(body);

    if (!filename || typeof filename !== "string") {
      return NextResponse.json(
        { error: "filename is required" },
        { status: 400 }
      );
    }

    return await withLibraryLock(async () => {
    const library = await scanLibrary();
    const videoIndex = library.videos.findIndex((v) => v.filename === filename);

    if (videoIndex === -1) {
      return NextResponse.json(
        { error: "Video not found" },
        { status: 404 }
      );
    }

    const current = library.videos[videoIndex];
    const now = new Date().toISOString();
    const corrections = { ...current.corrections, updatedAt: now };
    if (changes.description !== undefined) corrections.description = changes.description ?? "";
    if (changes.spoken_text !== undefined) corrections.spoken_text = changes.spoken_text;
    if (changes.tags !== undefined) corrections.tags = changes.tags.map(t => t.toLowerCase());
    const rejectedTags = changes.tags === undefined ? current.rejectedTags : [...new Set([
      ...(current.rejectedTags ?? []), ...clipTags(current).filter(t => !corrections.tags!.includes(t)),
    ])].filter(t => !corrections.tags!.includes(t));
    const metadata = { ...changes };
    delete metadata.spoken_text;
    const updated = { ...current, ...metadata, corrections, rejectedTags, updatedAt: now };

    library.videos[videoIndex] = updated;
    library.lastUpdated = new Date().toISOString();

    const previous = await loadLibrary();
    library.videos.push(...previous.videos.filter(clip => !library.videos.some(current => current.filename === clip.filename)));
    await saveLibrary(library);
    const activity = await beginActivity("library", "Correct library metadata");
    if (activity) await finishActivity(activity, null);

    return NextResponse.json(updated);
    });
  } catch (error) {
    console.error("Failed to update metadata:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update metadata" },
      { status: error instanceof z.ZodError ? 400 : 500 }
    );
  }
}
