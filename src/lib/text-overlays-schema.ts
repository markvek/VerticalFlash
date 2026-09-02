import { z } from "zod";
import { sidecarPath } from "./paths";

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
});

export type TextStyle = z.infer<typeof TextStyleZ>;

export const DEFAULT_TEXT_STYLE: TextStyle = {
  engine: "png",
  preset: "tiktok_box",
  position: "top",
};

// Per-shot on-screen text overrides written in the Library clips tab. Stored
// separately from recommendations so a re-match doesn't wipe them (same
// rationale as edit notes). A shot with no entry falls back to the
// analysis's detected on_screen_text, included whenever it's non-empty.
export const TextOverlaysZ = z.object({
  videoId: z.string(),
  updatedAt: z.string(),
  style: TextStyleZ,
  // shot_index (as a string key) -> the user's text + include toggle
  shots: z.record(
    z.object({
      text: z.string(),
      include: z.boolean(),
    })
  ),
});

export type TextOverlays = z.infer<typeof TextOverlaysZ>;

export function textOverlaysPath(videoId: string): string {
  return sidecarPath(videoId, "text-overlays");
}

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
