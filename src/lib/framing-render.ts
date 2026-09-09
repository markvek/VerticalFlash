import { execFileAsync as exec } from "./ffmpeg";
import { RENDER_SETTINGS } from "./render-schema";
import { type Framing, DEFAULT_FRAMING } from "./framing-schema";

const num = (n: number) => n.toFixed(6);

export function framingFilter(frame: Framing, sw: number, sh: number, duration: number, offset = 0, width = 1080, height = 1920) {
  const progress = `min(1,max(0,(t+${num(offset)})/${num(Math.max(duration, 0.001))}))`;
  const expr = (key: "x" | "y" | "zoom" | "offsetX" | "offsetY") => frame.motion === "static"
    ? num(frame.start[key] ?? 0)
    : `(${num(frame.start[key] ?? 0)}+${num((frame.end[key] ?? 0) - (frame.start[key] ?? 0))}*${progress})`;
  const scale = (frame.fit === "fill" ? Math.max : Math.min)(width / sw, height / sh);
  return {
    scale: `scale=w='max(2,trunc(${num(sw * scale)}*${expr("zoom")}/2)*2)':h='max(2,trunc(${num(sh * scale)}*${expr("zoom")}/2)*2)':eval=frame`,
    overlay: `overlay=x='(W-w)*${expr("x")}+W*${expr("offsetX")}':y='(H-h)*${expr("y")}+H*${expr("offsetY")}':eval=frame:format=auto:shortest=1`,
  };
}

export async function encodeFramedClip(input: {
  path: string; start: number; duration: number; output: string; framing?: Framing;
  offset?: number; totalDuration?: number; transparent?: boolean; available?: number;
  fill?: "clone" | "black" | "loop" | "slow_mo";
  width?: number; height?: number;
}) {
  const { path, start, duration, output, framing = DEFAULT_FRAMING, offset = 0, totalDuration = duration,
    transparent = false, available = duration, fill = "clone", width = RENDER_SETTINGS.width, height = RENDER_SETTINGS.height } = input;
  const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio:stream_side_data=rotation", "-of", "json", path]);
  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error("Cannot read video dimensions");
  const sar = String(stream.sample_aspect_ratio ?? "1:1").split(":").map(Number);
  const aspect = sar[0] > 0 && sar[1] > 0 ? sar[0] / sar[1] : 1;
  let sw = stream.width * aspect;
  let sh = stream.height;
  if (Math.abs(stream.side_data_list?.[0]?.rotation ?? 0) % 180 === 90) [sw, sh] = [sh, sw];
  const f = framingFilter(framing, sw, sh, totalDuration, offset, width, height);
  const timing = [`trim=duration=${num(Math.max(0.001, available))}`, "setpts=PTS-STARTPTS"];
  if (fill === "slow_mo") timing.push(`setpts=${num(duration / Math.max(available, 0.001))}*PTS`);
  if (fill === "loop") timing.push(`fps=30`, `loop=loop=-1:size=${Math.max(1, Math.round(available * 30))}:start=0`, "setpts=N/(30*TB)");
  timing.push(fill === "black"
    ? `tpad=stop_mode=add:stop_duration=${num(duration)}:color=black`
    : `tpad=stop_mode=clone:stop_duration=${num(duration)}`);
  const filters = [
    `color=c=black${transparent ? "@0" : ""}:s=${width}x${height}:r=30:d=${num(duration)},format=rgba[bg]`,
    `[0:v]${timing.join(",")},fps=30,${f.scale},setsar=1,format=rgba[fg]`,
    `[bg][fg]${f.overlay}[out]`,
  ];
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", num(start), "-i", path,
    "-filter_complex", filters.join(";"), "-map", "[out]", "-an", "-t", num(duration),
    ...(transparent ? ["-c:v", "qtrle", "-pix_fmt", "argb"] : ["-c:v", RENDER_SETTINGS.vcodec, "-preset", RENDER_SETTINGS.preset, "-crf", String(RENDER_SETTINGS.crf), "-pix_fmt", "yuv420p"]), output,
  ], { maxBuffer: 10 * 1024 * 1024 });
}
