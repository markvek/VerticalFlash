import { z } from "zod";

export const MIN_FRAME_ZOOM = 0.25;
export const MAX_FRAME_ZOOM = 4;

export const FramePointZ = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  zoom: z.number().finite().min(MIN_FRAME_ZOOM).max(MAX_FRAME_ZOOM),
  // Canvas-relative translation, separate from legacy crop alignment.
  offsetX: z.number().finite().min(-100).max(100).optional(),
  offsetY: z.number().finite().min(-100).max(100).optional(),
});
export const FramingZ = z.object({
  fit: z.enum(["fill", "fit"]),
  motion: z.enum(["static", "pan-zoom"]),
  start: FramePointZ,
  end: FramePointZ,
});
export type FramePoint = z.infer<typeof FramePointZ>;
export type Framing = z.infer<typeof FramingZ>;
export const DEFAULT_FRAMING: Framing = {
  fit: "fill", motion: "static",
  start: { x: 0.5, y: 0.5, zoom: 1 }, end: { x: 0.5, y: 0.5, zoom: 1 },
};
export const LayerZ = z.object({
  framing: FramingZ,
  mainVisible: z.boolean(),
  mainOpacity: z.number().finite().min(0).max(1),
  opacity: z.number().finite().min(0).max(1),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export type Layer = z.infer<typeof LayerZ>;
export const DEFAULT_LAYER: Layer = {
  framing: DEFAULT_FRAMING, mainVisible: true, mainOpacity: 1, opacity: 1, background: "#000000",
};
export const FramingDocumentZ = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  videoId: z.string(),
  updatedAt: z.string(),
  shots: z.record(z.string().regex(/^\d+$/), FramingZ),
  broll: z.record(z.string().min(1).max(200), LayerZ),
});
export type FramingDocument = z.infer<typeof FramingDocumentZ>;
export function emptyFraming(videoId: string): FramingDocument {
  return { version: 1, revision: 0, videoId, updatedAt: new Date(0).toISOString(), shots: {}, broll: {} };
}
export const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
export function frameAt(frame: Framing, progress: number): FramePoint {
  const t = frame.motion === "static" ? 0 : clamp(progress);
  return {
    x: frame.start.x + (frame.end.x - frame.start.x) * t,
    y: frame.start.y + (frame.end.y - frame.start.y) * t,
    zoom: frame.start.zoom + (frame.end.zoom - frame.start.zoom) * t,
    ...Object.fromEntries((["offsetX", "offsetY"] as const)
      .filter(key => frame.start[key] != null || frame.end[key] != null)
      .map(key => [key, (frame.start[key] ?? 0) + ((frame.end[key] ?? 0) - (frame.start[key] ?? 0)) * t])),
  };
}
export function frameRect(sw: number, sh: number, width: number, height: number, frame: Framing, progress: number) {
  const p = frameAt(frame, progress);
  const scale = (frame.fit === "fill" ? Math.max : Math.min)(width / sw, height / sh) * p.zoom;
  // Match the encoder's even pixel dimensions, including at intermediate keyframes.
  const w = Math.max(2, Math.floor(sw * scale / 2) * 2);
  const h = Math.max(2, Math.floor(sh * scale / 2) * 2);
  return { x: (width - w) * p.x + width * (p.offsetX ?? 0), y: (height - h) * p.y + height * (p.offsetY ?? 0), width: w, height: h };
}

export function withFrameCenter(frame: Framing, key: "start" | "end", sw: number, sh: number,
  width: number, height: number, centerX: number, centerY: number): Framing {
  const rect = frameRect(sw, sh, width, height, { ...frame, motion: "pan-zoom" }, key === "end" ? 1 : 0);
  const point = frame[key];
  return { ...frame, [key]: { ...point,
    offsetX: clamp((point.offsetX ?? 0) + (centerX - rect.x - rect.width / 2) / width, -100, 100),
    offsetY: clamp((point.offsetY ?? 0) + (centerY - rect.y - rect.height / 2) / height, -100, 100),
  } };
}

export interface PreviewSource {
  url: string;
  start: number;
  end: number;
  offset: number;
  warning?: string;
  playback?: { available: number; fill: "clone" | "black" | "loop" | "slow_mo" };
}
