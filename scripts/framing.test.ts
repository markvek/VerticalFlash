import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_FRAMING, DEFAULT_LAYER, emptyFraming, frameAt, frameRect, FramingZ, withFrameCenter, type Framing } from "../src/lib/framing-schema";

const exec = promisify(execFile);
let root: string;
let encoder: typeof import("../src/lib/framing-render");
let store: typeof import("../src/lib/framing-store");
let paths: typeof import("../src/lib/paths");
before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "framing-test-")); process.env.DATA_DIR = root;
  paths = await import("../src/lib/paths"); await paths.ensureDataDirs();
  encoder = await import("../src/lib/framing-render"); store = await import("../src/lib/framing-store");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1.2", "-vf", "drawbox=x=160:y=0:w=160:h=180:c=blue:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "wide.mp4")]);
});
after(() => fs.rm(root, { recursive: true, force: true }));

async function pixels(file: string, t = 0) {
  const { stdout } = await exec("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}
const pixel = (data: Buffer, x: number, y: number, width = 90) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test("framing clamps progress, preserves aspect ratio, and validates limits", () => {
  const frame: Framing = { ...DEFAULT_FRAMING, motion: "pan-zoom", end: { x: 1, y: 0, zoom: 2 } };
  assert.deepEqual(frameAt(frame, 2), frame.end);
  assert.deepEqual(frameAt(frame, -1), frame.start);
  assert.equal(frameAt(frame, 0.5).zoom, 1.5);
  for (const [w, h] of [[1920, 1080], [1080, 1080], [1080, 1920]]) {
    const fill = frameRect(w, h, 1080, 1920, DEFAULT_FRAMING, 0);
    assert.ok(fill.width >= 1080 && fill.height >= 1920);
    const fit = frameRect(w, h, 1080, 1920, { ...DEFAULT_FRAMING, fit: "fit" }, 0);
    assert.ok(fit.width <= 1080 && fit.height <= 1920);
  }
  assert.equal(FramingZ.safeParse({ ...frame, start: { ...frame.start, zoom: Infinity } }).success, false);
  assert.equal(FramingZ.safeParse({ ...frame, start: { ...frame.start, x: -0.1 } }).success, false);
});

test("saved edits survive reload and reject a concurrent stale writer", async () => {
  const doc = emptyFraming("framing-store");
  doc.shots[0] = { ...DEFAULT_FRAMING, fit: "fit", start: { ...DEFAULT_FRAMING.start, offsetX: -0.4, offsetY: 0.25 } };
  doc.broll.cover = { ...DEFAULT_LAYER, mainVisible: false, opacity: 0.4 };
  const saved = await store.writeFraming(doc);
  assert.equal(saved.revision, 1);
  assert.deepEqual(await store.readFraming(doc.videoId), saved);
  const results = await Promise.allSettled([store.writeFraming(saved), store.writeFraming(saved)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await store.readFraming(doc.videoId)).revision, 2);
});

test("placement leaves legacy motion unchanged and allows exact off-frame centers", () => {
  const legacy: Framing = { ...DEFAULT_FRAMING, motion: "pan-zoom", start: { x: 0.1, y: 0.8, zoom: 1.2 }, end: { x: 0.9, y: 0.2, zoom: 2 } };
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const r = frameRect(1920, 1080, 1080, 1920, legacy, t);
    const p = frameAt(legacy, t);
    assert.equal(r.x, (1080 - r.width) * p.x);
    assert.equal(r.y, (1920 - r.height) * p.y);
  }
  for (const [sw, sh] of [[1920, 1080], [1080, 1080], [1080, 1920]]) {
    const placed = withFrameCenter(legacy, "end", sw, sh, 1080, 1920, -125, 1400);
    const rect = frameRect(sw, sh, 1080, 1920, placed, 1);
    assert.ok(Math.abs(rect.x + rect.width / 2 + 125) < 1e-8);
    assert.ok(Math.abs(rect.y + rect.height / 2 - 1400) < 1e-8);
    assert.deepEqual(placed.start, legacy.start);
    assert.equal(placed.end.zoom, legacy.end.zoom);
    assert.equal(placed.end.x, legacy.end.x);
    const centered = withFrameCenter(placed, "end", sw, sh, 1080, 1920, 540, 960);
    const centerRect = frameRect(sw, sh, 1080, 1920, centered, 1);
    assert.ok(Math.abs(centerRect.x + centerRect.width / 2 - 540) < 1e-8);
    assert.ok(Math.abs(centerRect.y + centerRect.height / 2 - 960) < 1e-8);
  }
  assert.equal(FramingZ.safeParse({ ...legacy, start: { ...legacy.start, offsetX: Infinity } }).success, false);
  const motion = { ...DEFAULT_FRAMING, motion: "pan-zoom" as const, end: { ...DEFAULT_FRAMING.end, offsetX: 0.5, offsetY: -0.25 } };
  assert.equal(frameAt(motion, 0.5).offsetX, 0.25);
  assert.equal(frameAt(motion, 0.5).offsetY, -0.125);
});

test("translated landscape, square, and portrait exports match preview geometry", async () => {
  for (const [width, height] of [[320, 180], [180, 180], [90, 160]]) {
    const source = join(root, `position-${width}-${height}.mp4`);
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=red:s=${width}x${height}:r=30:d=0.5`, "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
    const framing: Framing = { ...DEFAULT_FRAMING, fit: "fit", motion: "pan-zoom",
      start: { ...DEFAULT_FRAMING.start, offsetX: 0.2, offsetY: -0.3 },
      end: { ...DEFAULT_FRAMING.end, offsetX: -0.15, offsetY: 0.2 } };
    const output = join(root, `position-${width}-${height}.mov`);
    await encoder.encodeFramedClip({ path: source, start: 0, duration: 0.5, framing, output, transparent: true, width: 90, height: 160 });
    for (const time of [0, 0.2, 0.4]) {
      const rgba = await pixels(output, time);
      const r = frameRect(width, height, 90, 160, framing, time / 0.5);
      for (let y = 5; y < 160; y += 10) for (let x = 5; x < 90; x += 10) {
        if ([x - r.x, x - r.x - r.width, y - r.y, y - r.y - r.height].some(d => Math.abs(d) < 2)) continue;
        const inside = x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        assert.equal(pixel(rgba, x, y)[3], inside ? 255 : 0, `${width}x${height}, t=${time}, (${x},${y})`);
      }
    }
  }
});

test("export pans across the original landscape image", async () => {
  const framing: Framing = { ...DEFAULT_FRAMING, motion: "pan-zoom", start: { x: 0, y: 0.5, zoom: 1 }, end: { x: 1, y: 0.5, zoom: 1.3 } };
  const output = join(root, "pan.mp4");
  await encoder.encodeFramedClip({ path: join(root, "wide.mp4"), start: 0, duration: 1, output, framing, width: 90, height: 160 });
  const first = pixel(await pixels(output), 45, 80);
  const last = pixel(await pixels(output, 0.9), 45, 80);
  assert.ok(first[0] > 200 && first[2] < 40, String(first));
  assert.ok(last[2] > 200 && last[0] < 40, String(last));
});

test("Fit keeps uncovered B-roll pixels transparent through export", async () => {
  const output = join(root, "fit.mov");
  await encoder.encodeFramedClip({ path: join(root, "wide.mp4"), start: 0, duration: 0.5, output,
    framing: { ...DEFAULT_FRAMING, fit: "fit" }, transparent: true, width: 90, height: 160 });
  const rgba = await pixels(output);
  assert.equal(pixel(rgba, 45, 5)[3], 0);
  assert.equal(pixel(rgba, 20, 80)[3], 255);
});

test("source ranges crossing master joins resolve to both untouched uploads", async () => {
  const a = "original-a.mp4", b = "original-b.mp4";
  await fs.copyFile(join(root, "wide.mp4"), join(paths.LIBRARY_DIR, a));
  await fs.copyFile(join(root, "wide.mp4"), join(paths.LIBRARY_DIR, b));
  const master = join(paths.STORYBOARDS_DIR, "master-test.mp4");
  await fs.copyFile(join(root, "wide.mp4"), master);
  await fs.writeFile(`${master}.metadata.json`, JSON.stringify({ kind: "master", title: "Test", createdAt: new Date().toISOString(), sourceClips: [{ filename: a, start: 0, end: 1 }, { filename: b, start: 1, end: 2 }] }));
  const { originalSources } = await import("../src/lib/framing-sources");
  const spans = await originalSources(master, 0.5, 1.5);
  assert.deepEqual(spans.map(s => [s.start, s.end, s.offset]), [[0.5, 1, 0], [0, 0.5, 0.5]]);
  assert.ok(spans.every(s => s.url.startsWith("/api/library/clips/")));
  await fs.unlink(join(paths.LIBRARY_DIR, b));
  const fallback = await originalSources(master, 0.5, 1.5);
  assert.ok(fallback[1].warning?.includes(b));
  assert.equal(fallback[1].path, master);
});

test("layer export hides or fades the picture without muting narration", async () => {
  const { renderRemake } = await import("../src/lib/render-remake");
  const now = new Date().toISOString();
  const videoId = "framing-composite";
  const main = join(paths.EDITING_DIR, `${videoId}.mp4`);
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=180x320:r=30:d=1.2", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-c:v", "libx264", "-c:a", "aac", "-shortest", main]);
  await fs.copyFile(join(root, "wide.mp4"), join(paths.LIBRARY_DIR, "cover.mp4"));
  const framing = emptyFraming(videoId);
  framing.shots[0] = DEFAULT_FRAMING;
  const shot = { index: 0, start_time: 0, end_time: 1.2, description: "Speaker", on_screen_text: "", spoken_text: "", camera_style: "static", screenshot: "" };
  framing.broll.cover = { ...DEFAULT_LAYER, framing: { ...DEFAULT_FRAMING, fit: "fit" }, mainVisible: false, background: "#00ff00", opacity: 0.5 };
  framing.broll.fade = { ...DEFAULT_LAYER, mainOpacity: 0.25, background: "#00ff00", opacity: 0 };
  const rendered = await renderRemake({ videoId, sourceVideo: `${videoId}.mp4`,
    analysis: { videoId, analyzedAt: now, model: "test", summary: "", hook_description: "", format: "other", tags: [], music: { title: "", author: "", usage: "", usage_note: "" }, full_transcript: "", shots: [shot] },
    recs: { videoId, generatedAt: now, model: "test", clipsConsidered: 0, shots: [{ shot_index: 0, recommendations: [], selected_filename: null, keep_source: true }] },
    editNotes: {}, library: { videos: [], lastUpdated: now }, framing, audio: "original",
    originalSources: { 0: [{ path: main, url: "", start: 0, end: 1.2, offset: 0 }] },
    broll: [{ id: "cover", filename: "cover.mp4", start: 0.3, end: 0.8, clip_start: 0, phrase: "", layer: framing.broll.cover },
      { id: "fade", filename: "cover.mp4", start: 0.6, end: 0.9, clip_start: 0, phrase: "", layer: framing.broll.fade }],
  });
  assert.equal(rendered.audio, "original");
  assert.equal(rendered.framing?.broll.cover.mainVisible, false);
  const output = join(paths.RENDERS_DIR, `${videoId}.mp4`);
  const before = pixel(await pixels(output, 0.1), 540, 80, 1080);
  const during = await pixels(output, 0.5);
  const background = pixel(during, 540, 80, 1080);
  const mixed = pixel(during, 200, 960, 1080);
  const after = pixel(await pixels(output, 1), 540, 80, 1080);
  assert.ok(before[0] > 230 && after[0] > 230);
  assert.ok(background[1] > 230 && background[0] < 20, String(background));
  assert.ok(mixed[0] > 100 && mixed[0] < 160 && mixed[1] > 100 && mixed[1] < 160, String(mixed));
  const faded = pixel(await pixels(output, 0.75), 540, 80, 1080);
  assert.ok(faded[0] > 50 && faded[0] < 80 && faded[1] > 175 && faded[1] < 210, String(faded));
  const overlapping = pixel(await pixels(output, 0.75), 200, 960, 1080);
  assert.ok(overlapping[0] > 145 && overlapping[0] < 175 && overlapping[1] > 80 && overlapping[1] < 110,
    `Main opacity must not fade lower B-roll: ${overlapping}`);
  const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=duration", "-of", "json", output]);
  assert.ok(Number(JSON.parse(stdout).streams[0].duration) >= 1.19);
  await store.writeFraming(framing);
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../src/app/api/downloads/[filename]/fork/route");
  const response = await POST(new NextRequest("http://localhost/fork", { method: "POST" }), { params: Promise.resolve({ filename: `${videoId}.mp4` }) });
  assert.equal(response.status, 200);
  const fork = await response.json();
  const forkFraming = await store.readFraming(fork.videoId);
  assert.deepEqual(forkFraming.broll, framing.broll);
  assert.equal(forkFraming.videoId, fork.videoId);
});

test("compatibility previews preserve the full image and reuse the cached file", async () => {
  const { framingPreview } = await import("../src/lib/framing-preview");
  const original = join(root, "wide.mp4");
  const [a, b] = await Promise.all([framingPreview(original), framingPreview(original)]);
  assert.equal(a, b);
  const stat = await fs.stat(a);
  assert.equal(await framingPreview(original), a);
  assert.equal((await fs.stat(a)).mtimeMs, stat.mtimeMs);
  const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "json", a]);
  const s = JSON.parse(stdout).streams[0];
  assert.equal(s.codec_name, "h264"); assert.ok(Math.abs(s.width / s.height - 16 / 9) < 0.01);
});
