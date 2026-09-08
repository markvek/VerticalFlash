import { nativeModel } from "@/lib/models/native";
import { after, NextRequest, NextResponse } from "next/server";
import { ensureFfmpeg, ffmpegErrorResponse } from "@/lib/ffmpeg";
import { isValidMusicFilename } from "@/lib/music-schema";
import { TIMING_SOURCES, type TimingSource } from "@/lib/project-meta";
import { assembleMaster } from "@/lib/master-assemble";
import { createMasterJob, runMasterJob } from "@/lib/master-jobs";
import { MasterJobStatusZ } from "@/lib/master-job-schema";
import { findLibraryFile } from "@/lib/library-store";

// Joining several long clips is a full re-encode
export const maxDuration = 600;

const MAX_CLIPS = 20;

// Build a master (the storyboard flow's long-form source) from library
// clips. Body: { clips: string[] (in order), title, timing_engine }.
export async function POST(request: NextRequest) {
  let body: {
    model?: unknown;
    clips?: unknown;
    title?: unknown;
    timing_engine?: unknown;
    background?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  let model: string;
  try { model = nativeModel(body.model); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid model" }, { status: 400 }); }

  const clips = Array.isArray(body.clips)
    ? body.clips.filter((c): c is string => typeof c === "string")
    : [];
  if (clips.length === 0) {
    return NextResponse.json({ error: "Pick at least one clip" }, { status: 400 });
  }
  if (clips.length > MAX_CLIPS) {
    return NextResponse.json(
      { error: `At most ${MAX_CLIPS} clips per master` },
      { status: 400 }
    );
  }
  if (clips.some((c) => !isValidMusicFilename(c))) {
    return NextResponse.json({ error: "Invalid clip filename" }, { status: 400 });
  }
  const title =
    (typeof body.title === "string" ? body.title.trim() : "").slice(0, 100) ||
    clips[0].replace(/\.[^.]+$/, "");
  let timingEngine: TimingSource | null = null;
  if (body.timing_engine != null) {
    if (
      typeof body.timing_engine !== "string" ||
      !(TIMING_SOURCES as readonly string[]).includes(body.timing_engine)
    ) {
      return NextResponse.json({ error: "Invalid timing_engine" }, { status: 400 });
    }
    timingEngine = body.timing_engine as TimingSource;
  }

  try {
    await ensureFfmpeg();
  } catch (error) {
    return ffmpegErrorResponse(error)!;
  }

  try {
    if (body.background === true) {
      for (const clip of clips) {
        if (!(await findLibraryFile(clip))) {
          return NextResponse.json({ error: `Clip not found in the library: ${clip}` }, { status: 400 });
        }
      }
      const job = await createMasterJob({ clips, title, timingEngine, model });
      after(() => runMasterJob(job.videoId));
      return NextResponse.json(MasterJobStatusZ.parse(job), { status: 202 });
    }
    const result = await assembleMaster({ clips, title, timingEngine, model });
    return NextResponse.json({
      filename: result.filename,
      videoId: result.videoId,
      displayName: result.displayName,
      duration: result.duration,
      sourceClips: result.sourceClips,
    });
  } catch (error) {
    console.error("master assembly failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not build the master" },
      { status: 500 }
    );
  }
}
