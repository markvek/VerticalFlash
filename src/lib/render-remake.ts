import { promises as fs } from "fs";
import { encodeFramedClip } from "./framing-render";
import type { FramingDocument, Layer } from "./framing-schema";
import type { FrameSource } from "./framing-sources";
import { execFileAsync } from "./ffmpeg";
import { join } from "path";
import type { GoogleGenAI } from "@google/genai";
import { getGeminiClient } from "./gemini";
import type { Analysis } from "./analysis-schema";
import {
  ShotRecommendationsZ,
  type Recommendation,
  type ShotRecommendations,
} from "./recommendation-schema";
import { generateTrimWindows, type TrimTarget } from "./trim-windows";
import { interpretEditNotes, type EditDirective } from "./edit-directives";
import { buildAssSubtitles, type AssEvent } from "./ass-subtitles";
import { overlayPlacement, rasterizeTextBlock } from "./png-overlays";
import {
  DEFAULT_TEXT_STYLE,
  resolveShotOverlay,
  type TextOverlays,
} from "./text-overlays-schema";
import type { ClipLibrary } from "./library-schema";
import { isGeneratedClip, resolveClipPath } from "./generation-schema";
import { findMusicTrack, musicPath } from "./music-library";
import {
  MAX_PAD_SECONDS,
  RENDER_SETTINGS,
  RenderManifestZ,
  type RenderManifest,
  type RenderShot,
} from "./render-schema";
import { ANALYSIS_DIR, RENDERS_DIR } from "./paths";
import { requireProjectPath } from "./download-files";
export { RENDERS_DIR } from "./paths";

const FFMPEG_MAX_BUFFER = 10 * 1024 * 1024;


export function renderVideoPath(videoId: string): string {
  return join(RENDERS_DIR, `${videoId}.mp4`);
}

export function renderManifestPath(videoId: string): string {
  return join(RENDERS_DIR, `${videoId}.render.json`);
}

async function probeDuration(path: string): Promise<number | null> {
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

// The homebrew ffmpeg bottle can be built without libass; detect the "ass"
// filter up front so a missing build degrades to a clear warning instead of
// a cryptic encode failure
async function hasAssFilter(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-filters",
    ]);
    return /^\s*[A-Z.]*\s+ass\s/m.test(stdout);
  } catch {
    return false;
  }
}

async function hasAudioStream(path: string): Promise<boolean> {
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

interface PlannedShot extends RenderShot {
  // The recommendation the clip came from (null for slugs), kept so the
  // on-demand trim stage can tell which clips still need windows
  rec: Recommendation | null;
}

type TimeGroup = "day" | "night";

// Collapse the time_of_day enum into comparable lighting groups; indoor
// and unclear clips are wildcards (null) — usable at any time of day
function toGroup(t: string | null | undefined): TimeGroup | null {
  if (t === "night") return "night";
  if (
    t === "morning" ||
    t === "midday" ||
    t === "afternoon" ||
    t === "golden_hour"
  ) {
    return "day";
  }
  return null;
}

function majorityGroup(groups: Array<TimeGroup | null>): TimeGroup | null {
  let day = 0;
  let night = 0;
  for (const g of groups) {
    if (g === "day") day++;
    else if (g === "night") night++;
  }
  if (day === night) return null;
  return day > night ? "day" : "night";
}

// Decide which clip fills each shot slot. A clip is eligible only when it
// can cover the shot's duration within MAX_PAD_SECONDS — last-frame padding
// bridges rounding, never a genuinely short clip. Each clip may be used at
// most once per render: user selections reserve their clips first, then the
// remaining shots claim clips in shot order. Clips sharing one time of day
// are preferred (soft — a mismatched clip still beats a black slug) unless
// the original video itself shifts time of day across shots, in which case
// each shot follows the original's lighting.
//
// A shot flagged keep_source (storyboard cutdowns, or the editor's "use
// original footage" toggle) bypasses all of that: it is cut from the
// project's own source video at its own start/end, never claims a library
// clip, casts no time-of-day vote, and needs no trim window. A fix note
// that names a clip still overrides it (the directive wins).
export function planShots(
  analysis: Analysis,
  recs: ShotRecommendations,
  sourceVideo: string,
  clipDurations: Map<string, number | null>,
  clipTimes: Map<string, string | null>,
  directives: Map<number, EditDirective>,
  warnings: string[],
  sourceShots: RenderInput["sourceShots"] = null
): {
  planned: PlannedShot[];
  timeMode: "uniform" | "follow_original" | "none";
  timeTarget: TimeGroup | null;
} {
  const recsByShot = new Map(recs.shots.map((s) => [s.shot_index, s]));
  const usesSource = (shotIndex: number): boolean =>
    recsByShot.get(shotIndex)?.keep_source === true &&
    !directives.get(shotIndex)?.clip;

  const eligibilityReason = (
    filename: string,
    duration: number,
    allowShort = false
  ): string | null => {
    const clipDuration = clipDurations.get(filename);
    if (clipDuration == null) return "could not read the clip file";
    if (!allowShort && clipDuration < duration - MAX_PAD_SECONDS) {
      return `clip is ${clipDuration.toFixed(1)}s but the shot needs ${duration.toFixed(1)}s`;
    }
    return null;
  };

  // Pass 1: reserve explicitly selected clips so an earlier shot's fallback
  // can't steal a clip the user picked for a later shot. On a duplicate
  // selection the earlier shot keeps the clip.
  const claimedBy = new Map<string, { shot: number; selected: boolean }>();
  const reservedFor = new Map<number, Recommendation>();
  for (const shot of analysis.shots) {
    // A fix note that names a clip supersedes the saved selection
    if (directives.get(shot.index)?.clip) continue;
    // Original-footage shots never reserve a library clip
    if (usesSource(shot.index)) continue;
    const recShot = recsByShot.get(shot.index);
    const selected = recShot?.selected_filename ?? null;
    if (!selected) continue;
    // A selection survives a re-match that dropped it from the rec list —
    // the user's explicit pick always outranks the recommendations
    const rec = recShot?.recommendations.find(
      (r) => r.filename === selected
    ) ?? {
      filename: selected,
      duration: clipDurations.get(selected) ?? null,
      confidence: "moderate" as const,
      reason: "Selected in the Library clips tab",
      source: "tags" as const,
      tag_overlap: [],
      score: 0,
      trim_start: null,
      trim_end: null,
      moment_note: null,
    };
    const claim = claimedBy.get(selected);
    if (claim) {
      warnings.push(
        `Shot ${shot.index + 1}: selected clip ${selected} already used by shot ${claim.shot} — using a fallback`
      );
      continue;
    }
    // A selection is used even when the clip is too short (the uncovered
    // remainder renders black) — only an unreadable file falls through to
    // pass 2, which records the skip reason and warning
    if (clipDurations.get(selected) == null) {
      warnings.push(
        `Shot ${shot.index + 1}: selected clip ${selected} could not be read — using a fallback`
      );
      continue;
    }
    claimedBy.set(selected, { shot: shot.index + 1, selected: true });
    reservedFor.set(shot.index, rec);
  }

  // Time-of-day target. When the original's shots span both day and night
  // (the video deliberately shifts lighting), each shot follows its own
  // group; otherwise one global target keeps the whole render consistent.
  const shotGroups = analysis.shots.map((s) => toGroup(s.time_of_day));
  const distinctShotGroups = new Set(
    shotGroups.filter((g): g is TimeGroup => g != null)
  );
  const followOriginal = distinctShotGroups.size >= 2;

  // Each unreserved shot's first usable candidate gets a vote (used when
  // neither selections nor the original's lighting give a signal)
  const candidateVotes: Array<TimeGroup | null> = [];
  for (const shot of analysis.shots) {
    if (reservedFor.has(shot.index)) continue;
    if (usesSource(shot.index)) continue;
    const duration = shot.end_time - shot.start_time;
    for (const r of recsByShot.get(shot.index)?.recommendations ?? []) {
      if (claimedBy.has(r.filename)) continue;
      if (eligibilityReason(r.filename, duration) != null) continue;
      candidateVotes.push(toGroup(clipTimes.get(r.filename)));
      break;
    }
  }

  let globalTarget = majorityGroup(
    Array.from(reservedFor.values()).map((r) => toGroup(clipTimes.get(r.filename)))
  );
  if (!globalTarget && distinctShotGroups.size === 1) {
    globalTarget = Array.from(distinctShotGroups)[0];
  }
  if (!globalTarget && followOriginal) {
    // Dominant lighting, as the fallback for shots with no group of their own
    globalTarget = majorityGroup(shotGroups);
  }
  if (!globalTarget) {
    globalTarget = majorityGroup(candidateVotes);
  }
  const timeMode = followOriginal
    ? ("follow_original" as const)
    : globalTarget
      ? ("uniform" as const)
      : ("none" as const);

  // Pass 2: fill the remaining shots in order
  const planned = analysis.shots.map((shot, shotPos): PlannedShot => {
    const duration = shot.end_time - shot.start_time;
    const recShot = recsByShot.get(shot.index);
    let skipped: PlannedShot["skipped"] = [];
    const directive = directives.get(shot.index) ?? null;

    if (usesSource(shot.index)) {
      // The shot plays its own footage from the source video; the trim
      // window is the shot itself, so nothing is claimed, padded, or
      // sent to the trim stage. A fix note without a clip has nothing to
      // act on here.
      if (directive) {
        warnings.push(
          `Shot ${shot.index + 1}: fix note ignored — the shot uses its original footage (name a library clip to override)`
        );
      }
      // A cutdown shot cuts from its footage range; anything else from the
      // short at its own times
      const footage = sourceShots?.[shot.index] ?? null;
      return {
        shot_index: shot.index,
        start_time: shot.start_time,
        end_time: shot.end_time,
        duration,
        clip: footage?.filename ?? sourceVideo,
        clip_source: "source",
        trim_start: footage ? footage.start : shot.start_time,
        trim_end: footage ? Math.round((footage.start + duration) * 1000) / 1000 : shot.end_time,
        moment_note: "original footage",
        time_of_day: shot.time_of_day ?? null,
        fill: null,
        edit_note: null, // attached from the raw notes by the caller
        edit_applied: null,
        padded_seconds: 0,
        skipped: [],
        on_screen_text: shot.on_screen_text,
        spoken_text: shot.spoken_text,
        burned_text: null,
        rec: null,
      };
    }
    const target = directive?.ignore_time_of_day
      ? null
      : followOriginal
        ? (shotGroups[shotPos] ?? globalTarget)
        : globalTarget;
    // A fill strategy from a fix note lets any clip cover the shot
    const allowShort = directive?.fill != null;

    let chosen: {
      rec: Recommendation;
      isSelected: boolean;
      isDirected?: boolean;
    } | null = null;
    let chosenMismatch = false;
    const reserved = reservedFor.get(shot.index);
    if (reserved) {
      chosen = { rec: reserved, isSelected: true };
    } else {
      // Fix-note clip first, then the selected clip (so its skip reason is
      // recorded), then the rest in existing (score) order — split into a
      // time-matching tier and a mismatched last-resort tier when a target
      // exists
      const candidates: Array<{
        rec: Recommendation;
        isSelected: boolean;
        isDirected?: boolean;
      }> = [];
      const selected = recShot?.selected_filename ?? null;
      for (const r of recShot?.recommendations ?? []) {
        if (r.filename === directive?.clip) continue; // re-added up front
        if (r.filename === selected) {
          candidates.unshift({ rec: r, isSelected: true });
        } else {
          candidates.push({ rec: r, isSelected: false });
        }
      }
      const matchesTarget = (filename: string) => {
        const g = toGroup(clipTimes.get(filename));
        return g == null || g === target;
      };
      const ordered = target
        ? [
            ...candidates.filter(
              (c) => c.isSelected || matchesTarget(c.rec.filename)
            ),
            ...candidates.filter(
              (c) => !c.isSelected && !matchesTarget(c.rec.filename)
            ),
          ]
        : candidates;
      if (directive?.clip) {
        const existing = recShot?.recommendations.find(
          (r) => r.filename === directive.clip
        );
        ordered.unshift({
          rec: existing ?? {
            filename: directive.clip,
            duration: clipDurations.get(directive.clip) ?? null,
            confidence: "moderate",
            reason: "Chosen by fix note",
            source: "tags",
            tag_overlap: [],
            score: 0,
            trim_start: null,
            trim_end: null,
            moment_note: null,
          },
          isSelected: false,
          isDirected: true,
        });
      }

      const attempt = (allowShortWalk: boolean, record: boolean): boolean => {
        for (const candidate of ordered) {
          const claim = claimedBy.get(candidate.rec.filename);
          const reuseOk = candidate.isDirected && directive?.allow_reuse;
          if (claim && !reuseOk) {
            if (record) {
              skipped.push({
                filename: candidate.rec.filename,
                reason: claim.selected
                  ? `reserved for shot #${claim.shot} (selected)`
                  : `already used by shot #${claim.shot}`,
              });
            }
            continue;
          }
          const reason = eligibilityReason(
            candidate.rec.filename,
            duration,
            allowShortWalk
          );
          if (reason != null) {
            if (record) {
              skipped.push({ filename: candidate.rec.filename, reason });
              if (candidate.isSelected) {
                warnings.push(
                  `Shot ${shot.index + 1}: selected clip ${candidate.rec.filename} skipped — ${reason}`
                );
              }
            }
            continue;
          }
          chosen = candidate;
          chosenMismatch =
            target != null &&
            !candidate.isSelected &&
            !candidate.isDirected &&
            !matchesTarget(candidate.rec.filename);
          if (!claim) {
            claimedBy.set(candidate.rec.filename, {
              shot: shot.index + 1,
              selected: false,
            });
          }
          // A phase-1 length skip recorded for this clip no longer applies
          skipped = skipped.filter(
            (k) => k.filename !== candidate.rec.filename
          );
          return true;
        }
        return false;
      };
      // Prefer clips that fully cover the shot; when none can, take the
      // best short clip and leave the uncovered remainder black
      if (!attempt(allowShort, true) && !allowShort) {
        attempt(true, false);
      }
    }

    if (!chosen) {
      warnings.push(
        `Shot ${shot.index + 1} has no eligible clip — rendered as a black slug`
      );
    } else if (chosenMismatch) {
      warnings.push(
        `Shot ${shot.index + 1}: no ${target} clip available — using ${
          clipTimes.get(chosen.rec.filename) ?? "unknown"
        } clip ${chosen.rec.filename}`
      );
    }
    // The directive counts as applied only when its clip (if any) was used
    const directiveApplied =
      directive != null &&
      chosen != null &&
      (directive.clip == null || chosen.rec.filename === directive.clip);
    if (directive && !directiveApplied) {
      warnings.push(
        `Shot ${shot.index + 1}: fix note could not be applied — see the shot's skip reasons`
      );
    }

    // A chosen clip that can't cover the shot plays its footage and leaves
    // the remaining time black, unless a fix note picked another strategy
    const chosenDuration = chosen
      ? (clipDurations.get(chosen.rec.filename) ?? null)
      : null;
    const deficit =
      chosen && chosenDuration != null ? duration - chosenDuration : 0;
    const fill =
      (directiveApplied ? (directive?.fill ?? null) : null) ??
      (deficit > MAX_PAD_SECONDS ? ("black" as const) : null);
    if (fill === "black" && chosen && chosenDuration != null) {
      warnings.push(
        `Shot ${shot.index + 1}: clip ${chosen.rec.filename} covers ${chosenDuration.toFixed(1)}s of the ${duration.toFixed(1)}s shot — remaining ${deficit.toFixed(1)}s is black`
      );
    }

    return {
      shot_index: shot.index,
      start_time: shot.start_time,
      end_time: shot.end_time,
      duration,
      clip: chosen?.rec.filename ?? null,
      clip_source: chosen
        ? isGeneratedClip(chosen.rec.filename)
          ? ("generated" as const)
          : chosen.isSelected
            ? ("selected" as const)
            : ("top_recommendation" as const)
        : ("none" as const),
      trim_start:
        directiveApplied && directive.trim_start != null
          ? directive.trim_start
          : (chosen?.rec.trim_start ?? null),
      trim_end:
        directiveApplied && directive.trim_start != null
          ? null
          : (chosen?.rec.trim_end ?? null),
      moment_note:
        directiveApplied && directive.trim_start != null
          ? "start set by fix note"
          : (chosen?.rec.moment_note ?? null),
      time_of_day: chosen ? (clipTimes.get(chosen.rec.filename) ?? null) : null,
      fill,
      edit_note: null, // attached from the raw notes by the caller
      edit_applied: directiveApplied ? directive.summary : null,
      padded_seconds: 0,
      skipped,
      on_screen_text: shot.on_screen_text,
      spoken_text: shot.spoken_text,
      burned_text: null, // set by the text burn stage
      rec: chosen?.rec ?? null,
    };
  });

  return { planned, timeMode, timeTarget: globalTarget };
}

// Which part of a longer clip to use is Gemini's call (the trim stage picks
// the best moment). When a chosen clip has no window yet, run that stage
// on-demand rather than silently cutting from the clip's start; the windows
// are written back into the recommendations file so re-renders reuse them.
async function fillMissingTrims(
  videoId: string,
  analysis: Analysis,
  recs: ShotRecommendations,
  planned: PlannedShot[],
  clipDurations: Map<string, number | null>,
  warnings: string[]
): Promise<void> {
  const shotByIndex = new Map(analysis.shots.map((s) => [s.index, s]));
  const clipTargets = new Map<string, TrimTarget[]>();
  for (const p of planned) {
    if (!p.clip || p.trim_start != null) continue;
    // Original-footage shots are cut at their own times (no window to
    // pick); generated clips carry explicit trims from the accept step, and
    // the trim stage only knows how to read the clip library anyway
    if (p.clip_source === "source" || isGeneratedClip(p.clip)) continue;
    const shot = shotByIndex.get(p.shot_index);
    if (!shot) continue;
    const targets = clipTargets.get(p.clip) || [];
    targets.push({
      shot_index: p.shot_index,
      duration: Math.round(p.duration * 10) / 10,
      description: shot.description,
      camera_style: shot.camera_style,
    });
    clipTargets.set(p.clip, targets);
  }
  if (clipTargets.size === 0) return;

  let ai: GoogleGenAI;
  try {
    ai = getGeminiClient();
  } catch {
    warnings.push(
      "Gemini is not configured — clips without a trim window are cut from the clip start"
    );
    return;
  }

  // Same shape as the match route's trim stage: low concurrency, one retry,
  // and a failed clip degrades to a start-0 cut instead of failing the render
  const queue = Array.from(clipTargets.entries());
  const runTrim = async ([filename, targets]: (typeof queue)[number]) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { windows } = await generateTrimWindows(
          ai,
          filename,
          clipDurations.get(filename) ?? null,
          targets
        );
        for (const p of planned) {
          if (p.clip !== filename) continue;
          const w = windows.get(p.shot_index);
          if (!w) continue;
          p.trim_start = w.start;
          p.trim_end = w.end;
          p.moment_note = w.note;
          if (p.rec) {
            p.rec.trim_start = w.start;
            p.rec.trim_end = w.end;
            p.rec.moment_note = w.note;
          }
        }
        return;
      } catch (error) {
        console.error(
          `render trim stage failed for ${filename} (attempt ${attempt + 1}):`,
          error
        );
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
    }
    warnings.push(
      `Could not pick a trim window for ${filename} — cutting from the clip start`
    );
  };
  const CONCURRENCY = 2;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) return;
      await runTrim(next);
    }
  });
  await Promise.all(workers);

  // Persist the freshly generated windows (planned shots share the rec
  // objects inside `recs`, so the updates above are already in it)
  try {
    await fs.writeFile(
      join(ANALYSIS_DIR, `${videoId}.recommendations.json`),
      JSON.stringify(ShotRecommendationsZ.parse(recs), null, 2)
    );
  } catch (error) {
    console.error("failed to persist on-demand trim windows:", error);
  }
}

const ENCODE_ARGS = [
  "-an",
  "-c:v",
  RENDER_SETTINGS.vcodec,
  "-preset",
  RENDER_SETTINGS.preset,
  "-crf",
  String(RENDER_SETTINGS.crf),
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-colorspace",
  "bt709",
];

async function encodeClipSegment(
  clipPath: string,
  start: number,
  duration: number,
  pad: number,
  segPath: string,
  padMode: "clone" | "add" = "clone"
): Promise<void> {
  const { width, height, fps } = RENDER_SETTINGS;
  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `fps=${fps}`,
    "setsar=1",
    "format=yuv420p",
  ];
  // Pad BEFORE any later overlay work so a Phase 2 text burn stays visible
  // during the tail: "clone" freezes the last frame (the ≤0.1s rounding
  // bridge and the fix-note freeze), "add" appends black frames (the
  // automatic tail for a clip that can't cover its shot)
  if (pad > 0.001) {
    filters.push(
      padMode === "add"
        ? `tpad=stop_mode=add:stop_duration=${pad.toFixed(3)}:color=black`
        : `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`
    );
  }
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      start.toFixed(3),
      "-i",
      clipPath,
      "-vf",
      filters.join(","),
      "-t",
      duration.toFixed(3),
      ...ENCODE_ARGS,
      segPath,
    ],
    { maxBuffer: FFMPEG_MAX_BUFFER }
  );
}

// Slow the window down so it exactly fills the shot (fix-note "slow_mo")
async function encodeSlowMoSegment(
  clipPath: string,
  start: number,
  available: number,
  duration: number,
  segPath: string
): Promise<void> {
  const { width, height, fps } = RENDER_SETTINGS;
  const factor = duration / available;
  const filters = [
    `trim=duration=${available.toFixed(3)}`,
    `setpts=${factor.toFixed(5)}*(PTS-STARTPTS)`,
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `fps=${fps}`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      start.toFixed(3),
      "-i",
      clipPath,
      "-vf",
      filters,
      "-t",
      duration.toFixed(3),
      ...ENCODE_ARGS,
      segPath,
    ],
    { maxBuffer: FFMPEG_MAX_BUFFER }
  );
}

// Repeat the window until it fills the shot (fix-note "loop"): encode the
// normalized window once, then loop that uniform intermediate
async function encodeLoopSegment(
  clipPath: string,
  start: number,
  available: number,
  duration: number,
  workDir: string,
  index: number,
  segPath: string
): Promise<void> {
  const basePath = join(workDir, `loopsrc_${String(index).padStart(2, "0")}.mp4`);
  await encodeClipSegment(clipPath, start, available, 0, basePath);
  const extraLoops = Math.max(0, Math.ceil(duration / available) - 1);
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-stream_loop",
      String(extraLoops),
      "-i",
      basePath,
      "-t",
      duration.toFixed(3),
      ...ENCODE_ARGS,
      segPath,
    ],
    { maxBuffer: FFMPEG_MAX_BUFFER }
  );
}

async function encodeSlugSegment(
  duration: number,
  segPath: string
): Promise<void> {
  const { width, height, fps } = RENDER_SETTINGS;
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${width}x${height}:r=${fps}:d=${duration.toFixed(3)}`,
      "-vf",
      "setsar=1,format=yuv420p",
      "-t",
      duration.toFixed(3),
      ...ENCODE_ARGS,
      segPath,
    ],
    { maxBuffer: FFMPEG_MAX_BUFFER }
  );
}

// One WAV per shot from its footage range (silence when the footage has no
// audio or is missing), joined in shot order. Same seek + length as the
// video segments, so the speaker stays in sync under every shot.
async function assembleShotAudio(
  planned: PlannedShot[],
  sourceShots: NonNullable<RenderInput["sourceShots"]>,
  workDir: string,
  warnings: string[]
): Promise<string> {
  const parts: string[] = [];
  const audible = new Map<string, boolean>();
  for (const p of planned) {
    const src = sourceShots[p.shot_index] ?? null;
    const part = join(workDir, `aud_${String(p.shot_index).padStart(2, "0")}.wav`);
    if (src && !audible.has(src.path)) audible.set(src.path, await hasAudioStream(src.path));
    if (src && audible.get(src.path)) {
      await execFileAsync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-ss",
          src.start.toFixed(3),
          "-t",
          p.duration.toFixed(3),
          "-i",
          src.path,
          "-vn",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-c:a",
          "pcm_s16le",
          part,
        ],
        { maxBuffer: FFMPEG_MAX_BUFFER }
      );
    } else {
      if (!src) {
        warnings.push(`Shot ${p.shot_index + 1}: footage not found — its audio is silent`);
      }
      await execFileAsync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=48000",
          "-t",
          p.duration.toFixed(3),
          "-c:a",
          "pcm_s16le",
          part,
        ],
        { maxBuffer: FFMPEG_MAX_BUFFER }
      );
    }
    parts.push(part);
  }
  const list = join(workDir, "audio-concat.txt");
  await fs.writeFile(list, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const out = join(workDir, "shots-audio.wav");
  await execFileAsync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out],
    { maxBuffer: FFMPEG_MAX_BUFFER }
  );
  return out;
}

export interface RenderInput {
  framing?: FramingDocument;
  originalSources?: Record<string, FrameSource[]>;
  videoId: string;
  analysis: Analysis;
  recs: ShotRecommendations;
  sourceVideo: string; // downloads/ filename of the original mp4
  // Current clip library, for the staleness check and clip time-of-day
  library: ClipLibrary;
  // Free-text per-shot fix notes (shot_index as string key)
  editNotes: Record<string, string>;
  // Soundtrack: a music-library track ("music", needs musicFilename), the
  // source download's audio ("original"), or silent ("none"). Precedence
  // when a track is missing: music > original > none — each step degrades
  // to the next with a warning.
  audio?: "music" | "original" | "none";
  musicFilename?: string | null;
  // Legacy toggle (pre-music renders): true = "original"
  includeOriginalAudio?: boolean;
  // Burn each shot's on-screen text over its clip (Phase 2)
  burnText?: boolean;
  // Saved text edits/toggles + burn style; shots without an entry fall
  // back to the analysis's detected on_screen_text
  textOverlays?: TextOverlays | null;
  // Storyboard cutdowns: per shot index, the footage file and file-local
  // range the shot lives in (the master, or an attached clip). Source shots
  // cut from here instead of the short mp4, and "original" audio is
  // assembled per shot from the same ranges, so a shot's length is just
  // its numbers. null entries fall back to the short.
  sourceShots?: Array<{ path: string; filename: string; start: number; end: number } | null> | null;
  // B-roll track: placed segments to composite over the cut, already
  // resolved to seconds on the output timeline. The speaker's audio is
  // untouched underneath.
  broll?: BrollRenderSegment[] | null;
}

export interface BrollRenderSegment {
  layer?: Layer;
  id: string;
  filename: string;
  start: number;
  end: number;
  clip_start: number | null;
  phrase: string;
}

// Composite the B-roll segments over the cut in one encode pass: each
// segment is normalized to the output format, shifted to its start time,
// and overlaid only between its start and end (eof_action=pass keeps the
// cut visible outside the window). A clip shorter than its segment holds
// its last frame.
async function overlayBroll(
  basePath: string,
  segments: BrollRenderSegment[],
  videoId: string,
  workDir: string,
  warnings: string[]
): Promise<{ path: string; applied: NonNullable<RenderManifest["broll"]> }> {
  const inputs: string[] = [];
  const applied: NonNullable<RenderManifest["broll"]> = [];
  for (const seg of segments) {
    const duration = seg.end - seg.start;
    if (duration < 0.1) continue;
    const clipPath = resolveClipPath(videoId, seg.filename);
    const clipDuration = await probeDuration(clipPath);
    if (clipDuration == null) {
      warnings.push(`B-roll ${seg.filename} could not be read — segment at ${seg.start.toFixed(1)}s skipped`);
      continue;
    }
    const start = Math.max(0, Math.min(seg.clip_start ?? 0, Math.max(0, clipDuration - 0.2)));
    const available = Math.min(clipDuration - start, duration);
    const pad = Math.max(0, duration - available);
    if (pad > 0.05) {
      warnings.push(
        `B-roll ${seg.filename} has ${available.toFixed(1)}s from ${start.toFixed(1)}s but the segment runs ${duration.toFixed(1)}s — last frame held`
      );
    }
    const segPath = join(workDir, `broll_${String(applied.length).padStart(2, "0")}.${seg.layer ? "mov" : "mp4"}`);
    try {
      if (seg.layer) {
        await encodeFramedClip({ path: clipPath, start, duration, available, output: segPath, framing: seg.layer.framing, transparent: true });
      } else {
        await encodeClipSegment(clipPath, start, duration, pad, segPath);
      }
    } catch (error) {
      if (seg.layer) throw error;
      console.error(`B-roll segment encode failed for ${seg.filename}:`, error);
      warnings.push(`B-roll ${seg.filename}: ffmpeg failed — segment at ${seg.start.toFixed(1)}s skipped`);
      continue;
    }
    inputs.push(segPath);
    applied.push({
      id: seg.id,
      filename: seg.filename,
      start: seg.start,
      end: seg.end,
      clip_start: Math.round(start * 100) / 100,
      phrase: seg.phrase,
    });
  }
  if (inputs.length === 0) return { path: basePath, applied };

  const filters: string[] = [];
  let prev = "[0:v]";
  // The top active segment controls the main picture, underneath all B-roll.
  if (applied.some(seg => {
    const layer = segments.find(s => s.id === seg.id)?.layer;
    return layer && (!layer.mainVisible || layer.mainOpacity < 1);
  })) {
    filters.push(`[0:v]split=${applied.length + 1}[base]${applied.map((_, i) => `[main${i}]`).join("")}`);
    prev = "[base]";
    applied.forEach((seg, i) => {
      const layer = segments.find(s => s.id === seg.id)?.layer;
      const enable = `gte(t,${seg.start.toFixed(3)})*lt(t,${seg.end.toFixed(3)})`;
      filters.push(`[main${i}]split[bg${i}][picture${i}]`);
      filters.push(`[bg${i}]drawbox=c=${layer?.background ?? "#000000"}:t=fill[color${i}]`);
      filters.push(`[picture${i}]format=rgba,colorchannelmixer=aa=${layer?.mainVisible === false ? 0 : layer?.mainOpacity ?? 1}[dim${i}]`);
      filters.push(`[color${i}][dim${i}]overlay=format=auto[mainview${i}]`);
      filters.push(`${prev}[mainview${i}]overlay=enable='${enable}':format=auto[under${i}]`);
      prev = `[under${i}]`;
    });
  }
  applied.forEach((seg, i) => {
    const s = seg.start.toFixed(3);
    const e = seg.end.toFixed(3);
    const layer = segments.find(s => s.id === seg.id)?.layer;
    const enable = `gte(t,${s})*lt(t,${e})`;
    filters.push(`[${i + 1}:v]setpts=PTS-STARTPTS+${s}/TB,format=rgba,colorchannelmixer=aa=${layer?.opacity ?? 1}[o${i}]`);
    filters.push(`${prev}[o${i}]overlay=eof_action=pass:enable='${enable}':format=auto[v${i}]`);
    prev = `[v${i}]`;
  });
  const outPath = join(workDir, "out-broll.mp4");
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      basePath,
      ...inputs.flatMap((p) => ["-i", p]),
      "-filter_complex",
      filters.join(";"),
      "-map",
      prev,
      ...ENCODE_ARGS,
      "-movflags",
      "+faststart",
      outPath,
    ],
    { maxBuffer: FFMPEG_MAX_BUFFER }
  );
  return { path: outPath, applied };
}

export async function renderRemake(
  input: RenderInput
): Promise<RenderManifest> {
  const {
    framing,
    originalSources,
    videoId,
    analysis,
    recs,
    sourceVideo,
    library,
    editNotes,
    includeOriginalAudio = false,
    musicFilename = null,
    burnText = false,
    textOverlays = null,
    sourceShots = null,
    broll = null,
  } = input;
  const audioMode: "music" | "original" | "none" =
    input.audio ?? (includeOriginalAudio ? "original" : "none");
  const warnings: string[] = [];
  const libraryClipCount = library.videos.filter((v) => v.analysis).length;
  const clipTimes = new Map<string, string | null>(
    library.videos.map((v) => [v.filename, v.analysis?.time_of_day ?? null])
  );

  // Translate the user's free-text fix notes into renderer directives;
  // failures degrade to warnings, never block the render
  let directives = new Map<number, EditDirective>();
  if (Object.keys(editNotes).length > 0) {
    try {
      const ai = getGeminiClient();
      const interpreted = await interpretEditNotes(
        ai,
        analysis,
        recs,
        library,
        editNotes
      );
      directives = interpreted.directives;
      warnings.push(...interpreted.warnings);
    } catch (error) {
      warnings.push(
        `Fix notes could not be interpreted (${
          error instanceof Error ? error.message : "Gemini error"
        }) — rendering without them`
      );
    }
  }

  // Exact durations for every candidate clip (the library metadata rounds
  // to 0.1s, and a clip may have changed on disk since matching)
  const candidateFiles = new Set<string>();
  for (const s of recs.shots) {
    for (const r of s.recommendations) candidateFiles.add(r.filename);
    // Selections may outlive the rec list they were made from
    if (s.selected_filename) candidateFiles.add(s.selected_filename);
  }
  for (const d of directives.values()) {
    if (d.clip) candidateFiles.add(d.clip);
  }
  const clipDurations = new Map<string, number | null>();
  for (const filename of candidateFiles) {
    clipDurations.set(
      filename,
      await probeDuration(resolveClipPath(videoId, filename))
    );
  }

  const { planned, timeMode, timeTarget } = planShots(
    analysis,
    recs,
    sourceVideo,
    clipDurations,
    clipTimes,
    directives,
    warnings,
    sourceShots
  );
  for (const p of planned) {
    p.edit_note = editNotes[String(p.shot_index)] ?? null;
  }
  // Staleness only matters for shots that draw on the library (a cutdown
  // made entirely of original footage never matched against it)
  if (
    recs.clipsConsidered < libraryClipCount &&
    planned.some((p) => p.clip_source !== "source")
  ) {
    warnings.push(
      `Matches were generated against ${recs.clipsConsidered} clips; the library now has ${libraryClipCount} analyzed — consider re-matching`
    );
  }
  await fillMissingTrims(
    videoId,
    analysis,
    recs,
    planned,
    clipDurations,
    warnings
  );

  await fs.mkdir(RENDERS_DIR, { recursive: true });
  const workDir = join(RENDERS_DIR, `.work-${videoId}`);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  try {
    // ffmpeg failure on a shot degrades it to a black slug (never a failed
    // render); the manifest records what was attempted
    const slugAfterFailure = async (
      p: PlannedShot,
      error: unknown,
      segPath: string
    ) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`segment encode failed for ${p.clip}:`, error);
      warnings.push(
        `Shot ${p.shot_index + 1}: ffmpeg failed on ${p.clip} — rendered as a black slug`
      );
      p.skipped.push({
        filename: p.clip ?? "",
        reason: `ffmpeg failed: ${message.slice(0, 200)}`,
      });
      p.clip = null;
      p.clip_source = "none";
      p.trim_start = null;
      p.trim_end = null;
      p.moment_note = null;
      p.time_of_day = null;
      p.fill = null;
      p.edit_applied = null;
      p.padded_seconds = 0;
      await encodeSlugSegment(p.duration, segPath);
    };

    const segPaths: string[] = [];
    for (let i = 0; i < planned.length; i++) {
      const p = planned[i];
      const segPath = join(workDir, `seg_${String(i).padStart(2, "0")}.mp4`);

      if (p.clip_source === "source") {
        // Cut the shot straight out of its footage at its own times — the
        // cutdown's master/attached clip when known, else the short itself;
        // never a library clip, so it skips resolveClipPath
        try {
          const frame = framing?.shots[String(p.shot_index)];
          const spans = originalSources?.[String(p.shot_index)];
          if (frame && spans?.length) {
            const parts: string[] = [];
            for (const [part, span] of spans.entries()) {
              const output = join(workDir, `framed_${i}_${part}.mp4`);
              if (span.warning) warnings.push(span.warning);
              await encodeFramedClip({ path: span.path, start: span.start, duration: span.end - span.start,
                output, framing: frame, offset: span.offset, totalDuration: p.duration });
              parts.push(output);
            }
            if (parts.length === 1) await fs.rename(parts[0], segPath);
            else {
              const list = join(workDir, `framed_${i}.txt`);
              await fs.writeFile(list, parts.map(path => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
              await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", segPath]);
            }
          } else await encodeClipSegment(
            sourceShots?.[p.shot_index]?.path ?? (await requireProjectPath(sourceVideo)),
            p.trim_start ?? p.start_time,
            p.duration,
            0,
            segPath
          );
        } catch (error) {
          if (framing?.shots[String(p.shot_index)]) throw error;
          await slugAfterFailure(p, error, segPath);
        }
      } else if (p.clip) {
        const clipDuration = clipDurations.get(p.clip);
        // Clamp the window so it fits the exact probed duration, then cover
        // whatever remains: normally a ≤MAX_PAD_SECONDS freeze (eligibility
        // caps it), or the fix note's fill strategy for larger gaps. With a
        // fill, the start only needs to leave some footage, not a full shot.
        let start = p.trim_start ?? 0;
        if (clipDuration != null) {
          // Black tails maximize footage (start clamps toward 0 on short
          // clips); loop/slow_mo/freeze fills keep the chosen moment and
          // only need some footage after the start
          const maxStart =
            p.fill && p.fill !== "black"
              ? Math.max(0, clipDuration - 0.2)
              : Math.max(0, clipDuration - p.duration);
          start = Math.max(0, Math.min(start, maxStart));
        }
        const available =
          clipDuration != null
            ? Math.min(clipDuration - start, p.duration)
            : p.duration;
        const pad = Math.max(0, p.duration - available);
        p.trim_start = Math.round(start * 10) / 10;
        p.trim_end = Math.round((start + available) * 10) / 10;
        p.padded_seconds = Math.round(pad * 100) / 100;

        try {
          const frame = framing?.shots[String(p.shot_index)];
          if (frame) {
            await encodeFramedClip({ path: resolveClipPath(videoId, p.clip), start, duration: p.duration,
              available, output: segPath, framing: frame,
              fill: p.fill === "loop" || p.fill === "slow_mo" || p.fill === "black" ? p.fill : "clone" });
          } else if (pad > 0.001 && p.fill === "loop") {
            await encodeLoopSegment(
              resolveClipPath(videoId, p.clip),
              start,
              available,
              p.duration,
              workDir,
              i,
              segPath
            );
          } else if (pad > 0.001 && p.fill === "slow_mo") {
            await encodeSlowMoSegment(
              resolveClipPath(videoId, p.clip),
              start,
              available,
              p.duration,
              segPath
            );
          } else {
            await encodeClipSegment(
              resolveClipPath(videoId, p.clip),
              start,
              p.duration,
              pad,
              segPath,
              p.fill === "black" ? "add" : "clone"
            );
          }
        } catch (error) {
          if (framing?.shots[String(p.shot_index)]) throw error;
          await slugAfterFailure(p, error, segPath);
        }
      } else {
        await encodeSlugSegment(p.duration, segPath);
      }
      segPaths.push(segPath);
    }

    // Uniform segments concat as a lossless stream copy; +faststart puts
    // the moov atom up front so the <video> element can start immediately
    const concatList = join(workDir, "concat.txt");
    await fs.writeFile(
      concatList,
      segPaths.map((p) => `file '${p}'`).join("\n")
    );
    const outPath = join(workDir, "out.mp4");
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
        outPath,
      ],
      { maxBuffer: FFMPEG_MAX_BUFFER }
    );

    // B-roll track: composite the placed segments over the cut before the
    // text burn, so on-screen text stays on top of the B-roll
    let brollBase = outPath;
    let brollApplied: NonNullable<RenderManifest["broll"]> = [];
    if (broll && broll.length > 0) {
      try {
        const result = await overlayBroll(outPath, broll, videoId, workDir, warnings);
        brollBase = result.path;
        brollApplied = result.applied;
      } catch (error) {
        console.error("B-roll overlay failed:", error);
        if (broll.some(s => s.layer)) throw error;
        warnings.push("Compositing the B-roll track failed — rendered without it");
      }
    }

    // Phase 2: burn the per-shot on-screen text over the cut — one extra
    // encode pass; the concat above stays a lossless stream copy. The "png"
    // engine composites rasterized text blocks with the overlay filter
    // (rounded pills, color emoji); "ass" burns libass subtitles and remains
    // the fallback.
    let burnedPath = brollBase;
    let textBurn: RenderManifest["text_burn"] = null;
    if (burnText) {
      let style = textOverlays?.style ?? DEFAULT_TEXT_STYLE;
      // Events run on the output timeline: cumulative segment durations,
      // which mirror the original's shots one-for-one
      const events: Array<{ p: PlannedShot; event: AssEvent }> = [];
      let cursor = 0;
      for (const p of planned) {
        const { text, include } = resolveShotOverlay(
          textOverlays,
          p.shot_index,
          p.on_screen_text
        );
        const trimmed = text.trim();
        if (include && trimmed) {
          events.push({
            p,
            event: { start: cursor, end: cursor + p.duration, text: trimmed },
          });
        }
        cursor += p.duration;
      }
      const hasEmoji = events.some((e) =>
        /\p{Extended_Pictographic}/u.test(e.event.text)
      );
      // libass drops color emoji, so emoji text always takes the png engine
      // regardless of the stored style
      if (style.engine === "ass" && hasEmoji) {
        style = { ...style, engine: "png" };
      }
      let burned = false;
      if (events.length === 0) {
        warnings.push(
          "Text burn was requested, but every shot's text is empty or excluded — nothing to burn"
        );
        burned = true; // nothing for the ass fallback to do either
      } else if (style.engine === "png") {
        try {
          const textDir = join(workDir, "text");
          await fs.mkdir(textDir, { recursive: true });
          // One PNG per distinct text; each event still gets its own -i so
          // no filter-graph stream label is consumed twice
          const blockFiles = new Map<string, string>();
          for (const e of events) {
            if (!blockFiles.has(e.event.text)) {
              const file = join(textDir, `block_${blockFiles.size}.png`);
              await fs.writeFile(
                file,
                await rasterizeTextBlock(e.event.text, style)
              );
              blockFiles.set(e.event.text, file);
            }
          }
          const { x, y } = overlayPlacement(style);
          const steps = events.map((e, i) => {
            const src = i === 0 ? "[0:v]" : `[v${i}]`;
            const out = i === events.length - 1 ? "[vout]" : `[v${i + 1}]`;
            // End a hair early so back-to-back shots never show two texts
            // on the boundary frame
            const enable = `between(t,${e.event.start.toFixed(3)},${Math.max(
              e.event.start,
              e.event.end - 0.001
            ).toFixed(3)})`;
            return `${src}[${i + 1}:v]overlay=x=${x}:y=${y}:enable='${enable}'${out}`;
          });
          const pngPath = join(workDir, "out-text-png.mp4");
          await execFileAsync(
            "ffmpeg",
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-i",
              outPath,
              ...events.flatMap((e) => ["-i", blockFiles.get(e.event.text)!]),
              "-filter_complex",
              steps.join(";"),
              "-map",
              "[vout]",
              ...ENCODE_ARGS,
              "-movflags",
              "+faststart",
              pngPath,
            ],
            { maxBuffer: FFMPEG_MAX_BUFFER }
          );
          burnedPath = pngPath;
          textBurn = {
            engine: "png",
            preset: style.preset,
            position: style.position,
            shots_burned: events.length,
          };
          for (const e of events) e.p.burned_text = e.event.text;
          burned = true;
        } catch (error) {
          console.error("png text burn failed:", error);
          warnings.push(
            "The PNG text engine failed — falling back to ASS subtitles" +
              (hasEmoji ? " (emoji may be dropped)" : "")
          );
        }
      }
      if (!burned && !(await hasAssFilter())) {
        warnings.push(
          "This ffmpeg build has no libass 'ass' filter — homebrew's plain ffmpeg formula dropped it; `brew install ffmpeg-full` and put /opt/homebrew/opt/ffmpeg-full/bin first on PATH to burn text; rendered without it"
        );
      } else if (!burned) {
        await fs.writeFile(
          join(workDir, "overlays.ass"),
          buildAssSubtitles(
            events.map((e) => e.event),
            style
          )
        );
        const textPath = join(workDir, "out-text.mp4");
        try {
          // Relative ass= path + cwd sidesteps filter-graph path escaping
          await execFileAsync(
            "ffmpeg",
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-i",
              outPath,
              "-vf",
              "ass=overlays.ass",
              ...ENCODE_ARGS,
              "-movflags",
              "+faststart",
              textPath,
            ],
            { maxBuffer: FFMPEG_MAX_BUFFER, cwd: workDir }
          );
          burnedPath = textPath;
          textBurn = {
            engine: "ass",
            preset: style.preset,
            position: style.position,
            shots_burned: events.length,
          };
          for (const e of events) e.p.burned_text = e.event.text;
        } catch (error) {
          console.error("text burn failed:", error);
          warnings.push(
            "Burning the on-screen text failed — rendered without it"
          );
        }
      }
    }

    // Soundtrack. Music beats original beats none; any failure falls
    // through to the next option with a warning, never a failed render.
    let audio: "music" | "original" | "none" = "none";
    let music: RenderManifest["music"] = null;
    let finalPath = burnedPath;
    const videoDuration = (await probeDuration(burnedPath)) ?? 0;

    if (audioMode === "music") {
      const track = musicFilename ? await findMusicTrack(musicFilename) : null;
      if (!track) {
        warnings.push(
          `Song ${musicFilename ?? "(none)"} is not in the music library — falling back to the original audio`
        );
      } else {
        const trackPath = musicPath(track.filename);
        const trackDuration = await probeDuration(trackPath);
        if (trackDuration == null) {
          warnings.push(
            `Song ${track.filename} could not be read — falling back to the original audio`
          );
        } else {
          const muxPath = join(workDir, "out-music.mp4");
          try {
            // -stream_loop -1 repeats a short song; -shortest ends the mux
            // with the video
            await execFileAsync(
              "ffmpeg",
              [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                burnedPath,
                "-stream_loop",
                "-1",
                "-i",
                trackPath,
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                "-movflags",
                "+faststart",
                muxPath,
              ],
              { maxBuffer: FFMPEG_MAX_BUFFER }
            );
            finalPath = muxPath;
            audio = "music";
            music = {
              filename: track.filename,
              title: track.title,
              author: track.author,
              looped: trackDuration < videoDuration - 0.5,
            };
          } catch (error) {
            console.error("music mux failed:", error);
            warnings.push(
              `Muxing the song ${track.filename} failed — falling back to the original audio`
            );
          }
        }
      }
    }

    // Cutdown: the speaker's audio is assembled shot by shot from the
    // footage ranges (the short mp4 may no longer match after timeline
    // edits), then laid under the cut — B-roll shots included
    if (audio === "none" && audioMode !== "none" && sourceShots) {
      const muxPath = join(workDir, "out-audio.mp4");
      try {
        const audioPath = await assembleShotAudio(planned, sourceShots, workDir, warnings);
        await execFileAsync(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            burnedPath,
            "-i",
            audioPath,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            "-movflags",
            "+faststart",
            muxPath,
          ],
          { maxBuffer: FFMPEG_MAX_BUFFER }
        );
        finalPath = muxPath;
        audio = "original";
      } catch (error) {
        console.error("shot audio assembly failed:", error);
        warnings.push(
          "Assembling the speaker audio from the footage failed — falling back to the short's own audio track"
        );
      }
    }

    // Lay the original download's audio track over the cut. The render
    // mirrors the original shot-for-shot, so the timelines line up;
    // -shortest trims any sub-second rounding drift at the tail.
    if (audio === "none" && audioMode !== "none") {
      const sourcePath = await requireProjectPath(sourceVideo);
      if (!(await hasAudioStream(sourcePath))) {
        warnings.push(
          "Original audio requested, but the source video has no audio track — rendered silent"
        );
      } else {
        const muxPath = join(workDir, "out-audio.mp4");
        try {
          await execFileAsync(
            "ffmpeg",
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-i",
              burnedPath,
              "-i",
              sourcePath,
              "-map",
              "0:v:0",
              "-map",
              "1:a:0",
              "-c:v",
              "copy",
              "-c:a",
              "aac",
              "-b:a",
              "192k",
              "-shortest",
              "-movflags",
              "+faststart",
              muxPath,
            ],
            { maxBuffer: FFMPEG_MAX_BUFFER }
          );
          finalPath = muxPath;
          audio = "original";
        } catch (error) {
          console.error("audio mux failed:", error);
          warnings.push(
            "Muxing the original audio failed — rendered silent instead"
          );
        }
      }
    }

    const durationSeconds = (await probeDuration(finalPath)) ?? 0;
    // Atomic replace: a killed render never corrupts an existing output
    await fs.rename(finalPath, renderVideoPath(videoId));

    const manifest: RenderManifest = RenderManifestZ.parse({
      framing,
      videoId,
      renderedAt: new Date().toISOString(),
      sourceVideo,
      output: `${videoId}.mp4`,
      durationSeconds: Math.round(durationSeconds * 10) / 10,
      settings: { ...RENDER_SETTINGS },
      recommendationsGeneratedAt: recs.generatedAt,
      clipsConsidered: recs.clipsConsidered,
      audio,
      music,
      time_mode: timeMode,
      time_target: timeTarget,
      text_burn: textBurn,
      warnings,
      shots: planned.map(({ rec: _rec, ...shot }) => shot),
      broll: brollApplied,
    });

    const manifestPath = renderManifestPath(videoId);
    const tmp = `${manifestPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
    await fs.rename(tmp, manifestPath);

    return manifest;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
