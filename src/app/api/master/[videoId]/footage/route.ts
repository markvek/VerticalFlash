import { NextRequest, NextResponse } from "next/server";
import { includeStoryboardFootage, listStoryboardFootage } from "@/lib/storyboard-footage";
import { isValidVideoId } from "@/lib/video-id";

export const maxDuration = 120;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
  try { return NextResponse.json({ footage: await listStoryboardFootage(videoId) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load footage" }, { status: 500 }); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
  try {
    const { filename } = await request.json();
    if (typeof filename !== "string" || !filename || /[/\\]/.test(filename)) return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    return NextResponse.json({ items: await includeStoryboardFootage(videoId, filename) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not include footage" }, { status: 400 });
  }
}
