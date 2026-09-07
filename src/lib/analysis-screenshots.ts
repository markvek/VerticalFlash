import { promises as fs } from "fs";
import { join } from "path";
import { execFileAsync } from "./ffmpeg";
import { ANALYSIS_DIR } from "./paths";

// One JPEG per shot at the shot's midpoint, under analysis/<videoId>/.
// Shared by the video analysis route and the storyboard accept step.
// Replace one shot's frame (timeline edits); other shots' files stay
export async function extractShotScreenshot(
  videoPath: string,
  videoId: string,
  index: number,
  seconds: number
): Promise<void> {
  const shotsDir = join(ANALYSIS_DIR, videoId);
  await fs.mkdir(shotsDir, { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    Math.max(0, seconds).toFixed(3),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    join(shotsDir, `shot_${index}.jpg`),
  ]);
}

export async function extractScreenshots(
  videoPath: string,
  videoId: string,
  shots: Array<{ start_time: number; end_time: number }>,
  duration: number
): Promise<void> {
  const shotsDir = join(ANALYSIS_DIR, videoId);
  // Re-runs replace the whole shots directory
  await fs.rm(shotsDir, { recursive: true, force: true });
  await fs.mkdir(shotsDir, { recursive: true });

  for (let i = 0; i < shots.length; i++) {
    const midpoint = Math.min(
      (shots[i].start_time + shots[i].end_time) / 2,
      Math.max(duration - 0.1, 0)
    );
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      midpoint.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      join(shotsDir, `shot_${i}.jpg`),
    ]);
  }
}
