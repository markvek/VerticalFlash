import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { isValidVideoId } from "@/lib/video-id";
import { ANALYSIS_DIR } from "@/lib/paths";


export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string; shot: string }> }
) {
  const { videoId, shot } = await params;

  if (!isValidVideoId(videoId) || !/^\d+$/.test(shot)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  try {
    const data = await fs.readFile(
      join(ANALYSIS_DIR, videoId, `shot_${shot}.jpg`)
    );
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json({ error: "screenshot not found" }, { status: 404 });
  }
}
