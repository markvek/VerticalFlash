import { NextRequest, NextResponse } from "next/server";
import {
  acquireFromTikTok,
  deleteMusicTrack,
  loadMusicLibrary,
} from "@/lib/music-library";
import { isValidMusicFilename } from "@/lib/music-schema";

// Downloading a post video for the ffmpeg fallback can take a moment
export const maxDuration = 120;

// The music library: every track in music/, merged with its metadata
export async function GET() {
  try {
    return NextResponse.json(await loadMusicLibrary());
  } catch (error) {
    console.error("Failed to load music library:", error);
    return NextResponse.json(
      { error: "Failed to load the music library" },
      { status: 500 }
    );
  }
}

// Add a track from a TikTok post or sound link: { url }
export async function POST(request: NextRequest) {
  let url: string;
  try {
    const body = await request.json();
    url = typeof body?.url === "string" ? body.url.trim() : "";
  } catch {
    url = "";
  }
  if (!url) {
    return NextResponse.json(
      { error: "Paste a TikTok post or sound link" },
      { status: 400 }
    );
  }

  try {
    const result = await acquireFromTikTok(url);
    return NextResponse.json(result);
  } catch (error) {
    console.error("music acquisition failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not add that track",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  let filename: string;
  try {
    const body = await request.json();
    filename = typeof body?.filename === "string" ? body.filename : "";
  } catch {
    filename = "";
  }
  if (!isValidMusicFilename(filename)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }
  try {
    const removed = await deleteMusicTrack(filename);
    if (!removed) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("music delete failed:", error);
    return NextResponse.json(
      { error: "Failed to delete the track" },
      { status: 500 }
    );
  }
}
