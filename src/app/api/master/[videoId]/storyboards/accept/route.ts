import { promises as fs } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { STORYBOARDS_DIR } from "@/lib/paths";
import { NextRequest, NextResponse } from "next/server";
import { isValidVideoId } from "@/lib/video-id";
import { ensureFfmpeg, ffmpegErrorResponse } from "@/lib/ffmpeg";
import { readMasterSegments } from "@/lib/master-analyze";
import { readStoryboards, recordStoryboardEdit } from "@/lib/storyboard-store";
import { readProjectMeta } from "@/lib/project-meta";
import { findDownloadFile } from "@/lib/download-files";
import { buildCutdown } from "@/lib/cutdown-build";
import { z } from "zod";
import { StoryboardHandoffZ, type StoryboardHandoff } from "@/lib/virality-schema";
import { readSavedStoryboard } from "@/lib/storyboard-store";
import { readViralityReview } from "@/lib/storyboard-virality";
import { nativeModel } from "@/lib/models/native";

// Cutting the beats is a re-encode of a short's worth of video
export const maxDuration = 300;

const globalState = globalThis as typeof globalThis & { storyboardAccepts?: Set<string> };
const inFlight = globalState.storyboardAccepts ??= new Set<string>();

// Accept one storyboard: cut its beats out of the master into a new
// "cutdown" project and open it in the editor. Repeatable per storyboard.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!isValidVideoId(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let storyboardId: string;
  let options: StoryboardHandoff;
  let requestedRevision: number | undefined;
  let requestId: string | undefined;
  try {
    const body = StoryboardHandoffZ.extend({ request_id: z.string().uuid().optional(), storyboard_id: z.string().regex(/^[\w-]+$/), revision: z.number().int().positive().optional() }).parse(await request.json());
    storyboardId = body.storyboard_id;
    options = StoryboardHandoffZ.parse(body);
    requestedRevision = body.revision;
    requestId = body.request_id;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!storyboardId) {
    return NextResponse.json({ error: "storyboard_id is required" }, { status: 400 });
  }

  const requestPath = requestId ? join(STORYBOARDS_DIR, videoId, "accept-requests", `${requestId}.json`) : null;
  const fingerprint = createHash("sha256").update(JSON.stringify([storyboardId, requestedRevision, options])).digest("hex");
  const replay = async () => {
    if (!requestPath) return null;
    try {
      const saved = JSON.parse(await fs.readFile(requestPath, "utf8"));
      if (saved.fingerprint !== fingerprint) return NextResponse.json({ error: "This request key was used for different storyboard options." }, { status: 409 });
      const existing = await findDownloadFile(saved.result.videoId);
      if (!existing) return NextResponse.json({ error: "The edit created by this request was deleted. Start a new edit." }, { status: 409 });
      await recordStoryboardEdit(videoId, saved.storyboard, saved.result.filename);
      return NextResponse.json(saved.result);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return NextResponse.json({ error: "Could not recover the previous edit request" }, { status: 500 }); }
    return null;
  };
  const recovered = await replay();
  if (recovered) return recovered;

  try {
    await ensureFfmpeg();
  } catch (error) {
    return ffmpegErrorResponse(error)!;
  }

  const file = await findDownloadFile(videoId);
  if (!file) {
    return NextResponse.json({ error: "Master not found" }, { status: 404 });
  }
  const meta = await readProjectMeta(file.path);
  if (meta?.kind !== "master") {
    return NextResponse.json({ error: "Not a master project" }, { status: 400 });
  }
  const [segments, storyboards] = await Promise.all([
    readMasterSegments(videoId),
    readStoryboards(videoId),
  ]);
  if (!segments || !storyboards) {
    return NextResponse.json(
      { error: "Generate storyboards first" },
      { status: 404 }
    );
  }
  const storyboard = storyboards.storyboards.find((s) => s.id === storyboardId);
  if (!storyboard) {
    return NextResponse.json({ error: "Unknown storyboard_id" }, { status: 404 });
  }
  if (requestedRevision != null && requestedRevision !== (storyboard.revision ?? 1)) return NextResponse.json({ error: "Storyboard changed. Refresh before creating an edit." }, { status: 409 });

  const key = `${videoId}:${storyboardId}`;
  const requestKey = requestId ? `${videoId}:request:${requestId}` : key;
  if (inFlight.has(key) || inFlight.has(requestKey)) {
    return NextResponse.json(
      { error: "This storyboard is already being cut" },
      { status: 409 }
    );
  }
  inFlight.add(key); inFlight.add(requestKey);
  try {
    const recovered = await replay();
    if (recovered) return recovered;
    const record = (await readSavedStoryboard(videoId, storyboard.id))!;
    const current = record.storyboards[0];
    if ((current.revision ?? 1) !== (storyboard.revision ?? 1)) return NextResponse.json({ error: "Storyboard changed. Refresh before creating an edit." }, { status: 409 });
    const review = await readViralityReview(videoId, current, record.request.brief);
    if ((options.add_text || options.add_broll) && !review) return NextResponse.json({ error: "Review this storyboard revision before adding recommended text or B-roll." }, { status: 409 });
    const result = await buildCutdown({
      masterPath: file.path,
      masterId: videoId,
      masterFilename: file.filename,
      masterMeta: meta,
      segments,
      storyboard,
      handoff: { options, review, model: nativeModel(record.request.model) },
    });
    if (requestPath) {
      await fs.mkdir(join(STORYBOARDS_DIR, videoId, "accept-requests"), { recursive: true });
      const temp = `${requestPath}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ fingerprint, result, storyboard }));
      await fs.rename(temp, requestPath);
    }
    // Remember which short came from this storyboard
    await recordStoryboardEdit(videoId, storyboard, result.filename);
    return NextResponse.json(result);
  } catch (error) {
    console.error("storyboard accept failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not cut the short" },
      { status: 500 }
    );
  } finally {
    inFlight.delete(key); inFlight.delete(requestKey);
  }
}
