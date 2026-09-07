import { z } from "zod";
import { TEXT_POSITIONS, TEXT_STYLE_PRESETS } from "./text-overlays-schema";

// Fixed output format: the standard iPhone camera recording spec
// (1080p @ 30fps), portrait for TikTok-style video.
export const RENDER_SETTINGS = {
  width: 1080,
  height: 1920,
  fps: 30,
  vcodec: "libx264",
  preset: "veryfast",
  crf: 20,
} as const;

// A clip may only fill a shot if it covers the shot's duration within
// this tolerance; last-frame padding is used only to bridge it.
export const MAX_PAD_SECONDS = 0.1;

export const RenderShotZ = z.object({
  shot_index: z.number(),
  start_time: z.number(),
  end_time: z.number(),
  duration: z.number(),
  // null = no eligible clip; the slot is a black slug. "source" = the shot
  // is filled from the project's own source video at the shot's own
  // start_time/end_time (storyboard cutdowns, or a shot the user flagged
  // "use original footage") — `clip` is then the downloads/ filename.
  clip: z.string().nullable(),
  clip_source: z.enum([
    "selected",
    "top_recommendation",
    "generated",
    "source",
    "none",
  ]),
  trim_start: z.number().nullable(),
  trim_end: z.number().nullable(),
  moment_note: z.string().nullable(),
  // The chosen clip's library time_of_day (null for slugs/unknown)
  time_of_day: z.string().nullable(),
  // How a too-short clip was made to cover the shot: a fix-note strategy
  // (freeze/loop/slow_mo) or the automatic "black" tail for the uncovered
  // remainder; null means only the ≤0.1s rounding freeze may apply
  fill: z.enum(["freeze", "loop", "slow_mo", "black"]).nullable(),
  // The user's free-text fix note for this shot, and what was applied
  edit_note: z.string().nullable(),
  edit_applied: z.string().nullable(),
  padded_seconds: z.number(),
  // Candidates passed over for this shot, with why
  skipped: z.array(
    z.object({ filename: z.string(), reason: z.string() })
  ),
  // Carried from the analysis so Phase 2 (text burn-in / captions) can
  // work from the manifest alone
  on_screen_text: z.string(),
  spoken_text: z.string(),
  // What the text burn stage put on this shot (null = nothing burned:
  // burning was off, the shot's text is empty, or its toggle excluded it)
  burned_text: z.string().nullable(),
});

export type RenderShot = z.infer<typeof RenderShotZ>;

// Full stored manifest: renders/<videoId>.render.json
export const RenderManifestZ = z.object({
  videoId: z.string(),
  renderedAt: z.string(),
  // null for prompt projects — there is no source TikTok, only the slate
  sourceVideo: z.string().nullable(),
  output: z.string(),
  durationSeconds: z.number(),
  settings: z.object({
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    vcodec: z.string(),
    preset: z.string(),
    crf: z.number(),
  }),
  recommendationsGeneratedAt: z.string(),
  clipsConsidered: z.number(),
  // "music" = a music-library track muxed over the cut (looped when shorter
  // than the video); "original" = the source download's audio track;
  // absent on manifests rendered before the audio option existed
  audio: z.enum(["music", "original", "none"]).optional(),
  // The track behind audio:"music" (absent/null otherwise)
  music: z
    .object({
      filename: z.string(),
      title: z.string(),
      author: z.string(),
      looped: z.boolean(),
    })
    .nullable()
    .optional(),
  // Time-of-day consistency: one shared target ("uniform"), the original's
  // per-shot lighting ("follow_original" — the original shifts time of day),
  // or no signal at all ("none")
  time_mode: z.enum(["uniform", "follow_original", "none"]),
  time_target: z.enum(["day", "night"]).nullable(),
  // On-screen text burned into the output. Engine "png" = rasterized text
  // blocks composited with the overlay filter (rounded TikTok pills, color
  // emoji); "ass" = libass subtitles, kept as the fallback. null = no burn
  // requested or nothing to burn; absent on manifests rendered before text
  // burning existed.
  text_burn: z
    .object({
      engine: z.enum(["ass", "png"]),
      preset: z.enum(TEXT_STYLE_PRESETS),
      position: z.enum(TEXT_POSITIONS),
      shots_burned: z.number(),
    })
    .nullable()
    .optional(),
  warnings: z.array(z.string()),
  shots: z.array(RenderShotZ),
  // B-roll track segments composited over the cut (absent on renders made
  // before the track existed)
  broll: z
    .array(
      z.object({
        id: z.string(),
        filename: z.string(),
        start: z.number(),
        end: z.number(),
        clip_start: z.number(),
        phrase: z.string(),
      })
    )
    .optional(),
});

export type RenderManifest = z.infer<typeof RenderManifestZ>;
