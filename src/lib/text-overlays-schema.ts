import { z } from "zod";

// Burn engines: "png" (the default) rasterizes each text block to a
// transparent PNG (rounded TikTok-style pill backgrounds, color emoji — see
// png-overlays.ts) and composites it with ffmpeg's overlay filter. "ass"
// renders styled libass subtitles and remains the fallback when png
// rasterization fails; emoji text always takes the png path because libass
// drops color emoji.
export const TEXT_ENGINES = ["ass", "png"] as const;

export const TEXT_STYLE_PRESETS = [
  "tiktok_box",
  "outline",
  "caption_bar",
] as const;

export const TEXT_POSITIONS = ["top", "center", "bottom"] as const;

export const TextStyleZ = z.object({
  engine: z.enum(TEXT_ENGINES),
  preset: z.enum(TEXT_STYLE_PRESETS),
  position: z.enum(TEXT_POSITIONS),
  fontSize: z.number().min(24).max(120).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export type TextStyle = z.infer<typeof TextStyleZ>;

export const DEFAULT_TEXT_STYLE: TextStyle = {
  engine: "png",
  preset: "tiktok_box",
  position: "top",
};

export const TextWordZ = z.object({
  text: z.string().min(1).max(100),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
}).refine(w => w.end > w.start, "Word end must follow its start");
export type TextWord = z.infer<typeof TextWordZ>;

export const ShotOverlayZ = z.object({
  text: z.string().max(500),
  include: z.boolean(),
  matchSpeech: z.boolean().optional(),
  // Source timestamps survive shot trimming and reordering.
  words: z.array(TextWordZ).max(10000).optional(),
  style: TextStyleZ.partial().optional(),
  startOffset: z.number().finite().nonnegative().optional(),
  endOffset: z.number().finite().nonnegative().optional(),
});
export type ShotOverlay = z.infer<typeof ShotOverlayZ>;
export const TextOverlaysZ = z.object({
  videoId: z.string(),
  updatedAt: z.string(),
  style: TextStyleZ,
  shots: z.record(ShotOverlayZ),
});
export type TextOverlays = z.infer<typeof TextOverlaysZ>;

// The fallback rule, shared by the renderer and the UI
export function resolveShotOverlay(
  overlays: TextOverlays | null,
  shotIndex: number,
  detectedText: string
): { text: string; include: boolean } {
  const entry = overlays?.shots[String(shotIndex)];
  if (entry) return { text: entry.text, include: entry.include };
  const text = detectedText.trim();
  return { text, include: text.length > 0 };
}
