import { NextRequest, NextResponse } from "next/server";
import { classifyGeminiError, getGeminiClient } from "@/lib/gemini";
import { ensureFfmpeg, ffmpegErrorResponse } from "@/lib/ffmpeg";
import { analyzeLibraryClip } from "@/lib/library-analyze";
import { findLibraryFile } from "@/lib/library-store";

// Gemini upload + video analysis can take a while
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let filename: string;
  try {
    const body = await request.json();
    filename = body.filename;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!filename || typeof filename !== "string") {
    return NextResponse.json(
      { error: "filename is required" },
      { status: 400 }
    );
  }

  const videoPath = await findLibraryFile(filename);
  if (!videoPath) {
    return NextResponse.json(
      { error: "Video file not found" },
      { status: 404 }
    );
  }

  try {
    await ensureFfmpeg();
  } catch (error) {
    return ffmpegErrorResponse(error)!;
  }

  try {
    getGeminiClient();
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Gemini not configured",
      },
      { status: 500 }
    );
  }

  try {
    const { updated } = await analyzeLibraryClip(filename);
    return NextResponse.json(updated);
  } catch (error) {
    console.error("clip analysis failed:", error);
    const { kind } = classifyGeminiError(error);
    const status =
      kind === "rate_limit" || kind === "daily_quota"
        ? 429
        : kind === "unavailable"
          ? 503
          : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status }
    );
  }
}
