import { findDownloadFile } from "@/lib/download-files";
import { probeDuration } from "@/lib/master-assemble";
import { readAttachedFootage } from "@/lib/storyboard-footage";
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
  const file = await findDownloadFile(videoId);
  const sourceDurations: Record<string, number> = {};
  const duration = file ? await probeDuration(file.path) : null;
  if (duration != null) sourceDurations.master = duration;
  for (const item of await readAttachedFootage(videoId)) sourceDurations[item.clip.filename] = item.duration;
  return NextResponse.json({ ...segments, sourceDurations });
}
