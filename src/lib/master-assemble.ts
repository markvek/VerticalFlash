import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { execFileAsync } from "./ffmpeg";
import { DOWNLOADS_DIR, STORYBOARDS_DIR } from "./paths";
import { findLibraryFile } from "./library-store";
import { RENDER_SETTINGS } from "./render-schema";
import type {
  MasterProjectMeta,
  MasterSourceClip,
  TimingSource,
} from "./project-meta";

// The storyboard flow's long-form source: the user's own clips joined into
// one video in storyboards/, shared by all of its saved ideas.
// Each clip is normalized to the render format first so the join is a
// lossless stream copy and the master already looks like the output.

const NAMES_FILE = join(DOWNLOADS_DIR, ".names.json");
const FFMPEG_MAX_BUFFER = 10 * 1024 * 1024;

export async function setDisplayName(
  filename: string,
  displayName: string
): Promise<void> {
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(await fs.readFile(NAMES_FILE, "utf8"));
  } catch {
    // no names yet
  }
  names[filename] = displayName.slice(0, 100);
  await fs.writeFile(NAMES_FILE, JSON.stringify(names, null, 2));
}

export async function probeDuration(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      path,
    ]);
    const duration = parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

export async function hasAudioStream(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      path,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// The renderer's normalization, plus audio: 1080x1920 @ 30 fps, AAC
// 48 kHz stereo. Clips without an audio track get silence so the concat
// stays uniform.
export async function normalizeClip(
  srcPath: string,
  destPath: string,
  opts?: { start?: number; duration?: number; crf?: number }
): Promise<void> {
  const { width, height, fps } = RENDER_SETTINGS;
  const audio = await hasAudioStream(srcPath);
  const seek = opts?.start != null && opts.start > 0 ? ["-ss", opts.start.toFixed(3)] : [];
  const limit = opts?.duration != null ? ["-t", opts.duration.toFixed(3)] : [];
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...seek,
    "-i",
    srcPath,
    ...(audio
      ? []
      : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
    ...limit,
    "-map",
    "0:v:0",
    "-map",
    audio ? "0:a:0" : "1:a:0",
    "-vf",
    [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      `fps=${fps}`,
      "setsar=1",
      "format=yuv420p",
    ].join(","),
    "-c:v",
    RENDER_SETTINGS.vcodec,
    "-preset",
    RENDER_SETTINGS.preset,
    "-crf",
    String(opts?.crf ?? RENDER_SETTINGS.crf),
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    // Audio padded with silence so it can never run shorter than the video
    // (a shorter track would make later "-shortest" muxes clip the picture)
    "-af",
    "apad",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "160k",
    "-shortest",
    "-movflags",
    "+faststart",
    destPath,
  ];
  await execFileAsync("ffmpeg", args, { maxBuffer: FFMPEG_MAX_BUFFER });
}

// Lossless join of uniform intermediates
export async function concatSegments(
  segPaths: string[],
  destPath: string,
  workDir: string
): Promise<void> {
  const concatList = join(workDir, "concat.txt");
  await fs.writeFile(
    concatList,
    segPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
  );
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatList,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      destPath,
    ],
    { maxBuffer: FFMPEG_MAX_BUFFER }
  );
}

export interface AssembleMasterInput {
  // Library filenames, in playback order
  clips: string[];
  title: string;
  timingEngine: TimingSource | null;
  model?: string;
}

export interface AssembleMasterResult {
  filename: string;
  videoId: string;
  displayName: string;
  duration: number;
  sourceClips: MasterSourceClip[];
}

export async function assembleMaster(
  input: AssembleMasterInput,
  videoId = `master-${randomUUID()}`
): Promise<AssembleMasterResult> {
  if (!/^master-[\w-]+$/.test(videoId)) throw new Error("Invalid master ID");
  const clipPaths: Array<{ filename: string; path: string }> = [];
  for (const filename of input.clips) {
    const path = await findLibraryFile(filename);
    if (!path) throw new Error(`Clip not found in the library: ${filename}`);
    clipPaths.push({ filename, path });
  }

  // Ids must not be purely numeric (those are TikTok post ids elsewhere)
  // and must survive extractVideoId: no underscore-digits pattern
  const filename = `${videoId}.mp4`;
  const videoPath = join(STORYBOARDS_DIR, filename);
  await fs.mkdir(STORYBOARDS_DIR, { recursive: true });
  const workDir = join(STORYBOARDS_DIR, `.work-${videoId}`);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  try {
    const segPaths: string[] = [];
    const sourceClips: MasterSourceClip[] = [];
    let cursor = 0;
    for (let i = 0; i < clipPaths.length; i++) {
      const segPath = join(workDir, `seg_${String(i).padStart(2, "0")}.mp4`);
      await normalizeClip(clipPaths[i].path, segPath);
      const segDuration = await probeDuration(segPath);
      if (segDuration == null) {
        throw new Error(`Could not read the normalized clip for ${clipPaths[i].filename}`);
      }
      sourceClips.push({
        filename: clipPaths[i].filename,
        start: Math.round(cursor * 1000) / 1000,
        end: Math.round((cursor + segDuration) * 1000) / 1000,
      });
      cursor += segDuration;
      segPaths.push(segPath);
    }

    if (segPaths.length === 1) {
      await fs.rename(segPaths[0], videoPath);
    } else {
      const outPath = join(workDir, "master.mp4");
      await concatSegments(segPaths, outPath, workDir);
      await fs.rename(outPath, videoPath);
    }

    const duration = (await probeDuration(videoPath)) ?? cursor;
    const now = new Date().toISOString();
    const meta: MasterProjectMeta & Record<string, unknown> = {
      kind: "master",
      title: input.title,
      createdAt: now,
      sourceClips,
      timingEngine: input.timingEngine,
      model: input.model,
      // Flat fields other prompts may read
      caption: input.title,
      savedAt: now,
    };
    await fs.writeFile(`${videoPath}.metadata.json`, JSON.stringify(meta, null, 2));

    const displayName = `🎬 ${input.title}`.slice(0, 100);
    await setDisplayName(filename, displayName);

    return { filename, videoId, displayName, duration, sourceClips };
  } catch (error) {
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(`${videoPath}.metadata.json`).catch(() => {});
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
