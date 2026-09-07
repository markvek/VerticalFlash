import { NextRequest, NextResponse } from "next/server";
import { execFileAsync, ensureFfmpeg, ffmpegErrorResponse } from "@/lib/ffmpeg";
import { promises as fs } from "fs";
import { join } from "path";
import { findMusicTrack, musicCoverPath, musicPath } from "@/lib/music-library";
import { isValidMusicFilename } from "@/lib/music-schema";
import { PROJECT_KINDS, type ProjectMeta } from "@/lib/project-meta";
import { DOWNLOADS_DIR, EDITING_DIR } from "@/lib/paths";

const NAMES_FILE = join(DOWNLOADS_DIR, ".names.json");

const MIN_SECONDS = 3;
const MAX_SECONDS = 180;

// Start an editing project from a brief. A created project gets a
// placeholder source: the song over its cover
// art (or a dark frame) at the target length, or a silent dark video when
// there is no song. The metadata sidecar carries the brief; the analyze
// route plans shots from it instead of watching a video.
export async function POST(request: NextRequest) {
  let body: {
    flow?: string;
    prompt?: string;
    music_filename?: string | null;
    duration_seconds?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const kind = body.flow === "music" ? "music" : "prompt";
  if (!PROJECT_KINDS.includes(kind)) {
    return NextResponse.json({ error: "Unknown flow" }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const musicFilename =
    typeof body.music_filename === "string" && body.music_filename
      ? body.music_filename
      : null;
  const duration = Number(body.duration_seconds);

  if (!Number.isFinite(duration) || duration < MIN_SECONDS || duration > MAX_SECONDS) {
    return NextResponse.json(
      { error: `Duration must be between ${MIN_SECONDS} and ${MAX_SECONDS} seconds` },
      { status: 400 }
    );
  }
  if (kind === "music" && !musicFilename) {
    return NextResponse.json({ error: "Pick a song first" }, { status: 400 });
  }
  if (kind === "prompt" && !prompt) {
    return NextResponse.json(
      { error: "Describe the video you want" },
      { status: 400 }
    );
  }
  if (musicFilename && !isValidMusicFilename(musicFilename)) {
    return NextResponse.json({ error: "Invalid song" }, { status: 400 });
  }

  const track = musicFilename ? await findMusicTrack(musicFilename) : null;
  if (musicFilename && !track) {
    return NextResponse.json(
      { error: "That song is not in the music library" },
      { status: 404 }
    );
  }

  try {
    await ensureFfmpeg();
  } catch (error) {
    return ffmpegErrorResponse(error)!;
  }

  // Ids must not be purely numeric (those are TikTok post ids elsewhere)
  // and must survive extractVideoId: no underscore-digits pattern, so the
  // whole stem becomes the videoId
  const videoId = `${kind === "music" ? "song" : "idea"}-${Date.now()}`;
  const filename = `${videoId}.mp4`;
  const videoPath = join(EDITING_DIR, filename);
  await fs.mkdir(EDITING_DIR, { recursive: true });
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });

  try {
    const coverPath = track ? musicCoverPath(track.filename) : null;
    const hasCover = coverPath
      ? await fs.access(coverPath).then(() => true).catch(() => false)
      : false;
    const size = "540x960";
    const videoInput = hasCover
      ? ["-loop", "1", "-framerate", "30", "-i", coverPath!]
      : ["-f", "lavfi", "-i", `color=c=#15151b:s=${size}:r=30`];
    const audioInput = track
      ? ["-stream_loop", "-1", "-i", musicPath(track.filename)]
      : [];
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...videoInput,
      ...audioInput,
      "-t",
      duration.toFixed(3),
      "-vf",
      `scale=540:960:force_original_aspect_ratio=increase,crop=540:960,format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "stillimage",
      "-r",
      "30",
      ...(track ? ["-c:a", "aac", "-b:a", "160k", "-shortest"] : ["-an"]),
      "-movflags",
      "+faststart",
      videoPath,
    ]);

    const now = new Date().toISOString();
    const meta: ProjectMeta & Record<string, unknown> = {
      kind,
      prompt,
      targetDuration: duration,
      music: track
        ? {
            filename: track.filename,
            title: track.title,
            author: track.author,
            duration: track.duration,
          }
        : null,
      createdAt: now,
      // Flat fields the existing analyze/captions prompts already read
      caption: prompt,
      musicTitle: track?.title ?? "",
      musicAuthor: track?.author ?? "",
      savedAt: now,
    };
    await fs.writeFile(
      `${videoPath}.metadata.json`,
      JSON.stringify(meta, null, 2)
    );

    // A readable display name instead of "Download N"
    const displayName = (
      kind === "music" && track
        ? `🎵 ${track.title}`
        : prompt.split(/\s+/).slice(0, 6).join(" ")
    ).slice(0, 100);
    let names: Record<string, string> = {};
    try {
      names = JSON.parse(await fs.readFile(NAMES_FILE, "utf8"));
    } catch {
      // no names yet
    }
    names[filename] = displayName;
    await fs.writeFile(NAMES_FILE, JSON.stringify(names, null, 2));

    return NextResponse.json({ filename, videoId, displayName });
  } catch (error) {
    console.error("project creation failed:", error);
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(`${videoPath}.metadata.json`).catch(() => {});
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create the project" },
      { status: 500 }
    );
  }
}
