import { projectModel } from "@/lib/models/native";
import { NextRequest, NextResponse } from "next/server";
import { loadLibrary } from "@/lib/library-store";
import { promises as fs } from "fs";
import { join } from "path";
import { getGeminiClient } from "@/lib/gemini";
import { AnalysisZ } from "@/lib/analysis-schema";
import { ShotRecommendationsZ } from "@/lib/recommendation-schema";
import { generateTrimWindows } from "@/lib/trim-windows";
import { isValidVideoId } from "@/lib/video-id";
import { ANALYSIS_DIR } from "@/lib/paths";


// Uploads the clip to Gemini — same budget as the full match route
export const maxDuration = 300;

// Pick the best moment within one clip for one shot — used after the user
// selects a clip from the All Clips picker, which arrives with null trims
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let shotIndex: number;
  let filename: string;
  try {
    const body = await request.json();
    shotIndex = body.shot_index;
    filename = body.filename;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (typeof shotIndex !== "number" || typeof filename !== "string") {
    return NextResponse.json(
      { error: "shot_index and filename are required" },
      { status: 400 }
    );
  }

  const recsPath = join(ANALYSIS_DIR, `${videoId}.recommendations.json`);
  try {
    const analysis = AnalysisZ.parse(
      JSON.parse(
        await fs.readFile(join(ANALYSIS_DIR, `${videoId}.json`), "utf8")
      )
    );
    const shot = analysis.shots.find((s) => s.index === shotIndex);
    if (!shot) {
      return NextResponse.json({ error: "Unknown shot_index" }, { status: 404 });
    }

    const stored = ShotRecommendationsZ.parse(
      JSON.parse(await fs.readFile(recsPath, "utf8"))
    );
    const recShot = stored.shots.find((s) => s.shot_index === shotIndex);
    const rec = recShot?.recommendations.find((r) => r.filename === filename);
    if (!rec) {
      return NextResponse.json(
        { error: "filename is not a recommendation for this shot" },
        { status: 404 }
      );
    }

    // Clip duration from the library metadata, when recorded (the trim
    // prompt tolerates an unknown duration)
    const library = await loadLibrary();
    const clipDuration =
      library.videos.find((v) => v.filename === filename)?.duration ?? null;

    const ai = getGeminiClient(await projectModel(videoId));
    const { windows } = await generateTrimWindows(ai, filename, clipDuration, [
      {
        shot_index: shotIndex,
        duration: Math.round((shot.end_time - shot.start_time) * 10) / 10,
        description: shot.description,
        camera_style: shot.camera_style,
      },
    ]);

    const w = windows.get(shotIndex);
    if (w) {
      rec.trim_start = w.start;
      rec.trim_end = w.end;
      rec.moment_note = w.note;
      await fs.writeFile(recsPath, JSON.stringify(stored, null, 2));
    }

    return NextResponse.json(stored);
  } catch (error) {
    console.error("manual trim failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Trim failed" },
      { status: 500 }
    );
  }
}
