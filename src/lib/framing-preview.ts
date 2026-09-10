import { promises as fs } from "fs";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { DATA_ROOT } from "./paths";
import { execFileAsync } from "./ffmpeg";

const pending = new Map<string, Promise<string>>();

// Only requested after a browser cannot decode the original. The key does not
// include editing settings: every crop/zoom/opacity edit reuses this same file.
export async function framingPreview(path: string): Promise<string> {
  const stat = await fs.stat(path);
  const key = createHash("sha256").update(`${path}:${stat.size}:${stat.mtimeMs}:v1`).digest("hex");
  const directory = join(DATA_ROOT, ".framing-previews");
  const output = join(directory, `${key}.mp4`);
  if (await fs.access(output).then(() => true, () => false)) return output;
  const existing = pending.get(key);
  if (existing) return existing;
  const task = (async () => {
    await fs.mkdir(directory, { recursive: true });
    const temporary = join(directory, `${key}.${randomUUID()}.mp4`);
    try {
      await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-map", "0:v:0", "-an",
        "-vf", "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", temporary],
        { maxBuffer: 10 * 1024 * 1024 });
      await fs.rename(temporary, output);
      return output;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
