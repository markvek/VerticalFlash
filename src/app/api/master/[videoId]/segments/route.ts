import { NextRequest, NextResponse } from "next/server";
import { isValidVideoId } from "@/lib/video-id";
import { readStoryboardSegments } from "@/lib/storyboard-footage";

// The master's timed transcript segments (written by the analyze route)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  const segments = await readStoryboardSegments(videoId);
  if (!segments) {
    return NextResponse.json(
      { error: "No transcript yet — analyze the master first" },
      { status: 404 }
    );
  }
  return NextResponse.json(segments);
}
