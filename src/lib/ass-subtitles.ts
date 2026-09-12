import { RENDER_SETTINGS } from "./render-schema";
import type { TextStyle } from "./text-overlays-schema";

// Builds the .ass subtitle file for the text burn stage. ASS (via ffmpeg's
// libass "ass" filter) gives outline/box styling, positioning, and automatic
// line wrapping; it cannot draw rounded per-line pills or color emoji — that
// is what the planned "png" overlay engine is for.

export interface AssEvent {
  start: number; // seconds on the output timeline
  end: number;
  text: string;
  style?: TextStyle;
}

// ASS colors are &HAABBGGRR — alpha 00 = opaque, FF = fully transparent
const WHITE = "&H00FFFFFF";
const BLACK = "&H00000000";
const BOX_BLACK = "&H50000000"; // ~69% opaque black

// Alignment uses numpad positions: 8 = top center, 5 = middle, 2 = bottom.
// Margins keep text inside TikTok's safe area (clear of the caption block
// and the right-hand icon rail).
const POSITIONS: Record<
  TextStyle["position"],
  { alignment: number; marginV: number }
> = {
  top: { alignment: 8, marginV: 250 },
  center: { alignment: 5, marginV: 0 },
  bottom: { alignment: 2, marginV: 460 },
};

interface PresetSpec {
  fontsize: number;
  outlineColour: string;
  backColour: string;
  borderStyle: number; // 1 = outline + shadow, 3 = opaque box per line
  outline: number; // outline width, or box padding for BorderStyle=3
  shadow: number;
}

const PRESETS: Record<TextStyle["preset"], PresetSpec> = {
  // Bold white on a semi-transparent black box per line
  tiktok_box: {
    fontsize: 64,
    outlineColour: BOX_BLACK,
    backColour: BOX_BLACK,
    borderStyle: 3,
    outline: 16,
    shadow: 0,
  },
  // Thick black stroke, no box — survives busy footage
  outline: {
    fontsize: 68,
    outlineColour: BLACK,
    backColour: BLACK,
    borderStyle: 1,
    outline: 6,
    shadow: 0,
  },
  // Smaller lower-third caption with a drop shadow
  caption_bar: {
    fontsize: 52,
    outlineColour: BLACK,
    backColour: "&H80000000",
    borderStyle: 1,
    outline: 4,
    shadow: 2,
  },
};

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

// Braces open libass override blocks and backslash starts control codes —
// neither is escapable inside dialogue text, so substitute lookalikes
function assText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\\/g, "/")
    .trim()
    .replace(/\n/g, "\\N");
}

export function buildAssSubtitles(events: AssEvent[], style: TextStyle): string {
  const preset = PRESETS[style.preset];
  const pos = POSITIONS[style.position];
  // Arial Black ships with macOS; libass falls back to the default sans
  // (with a log note, not a failure) when it's missing
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${RENDER_SETTINGS.width}`,
    `PlayResY: ${RENDER_SETTINGS.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial Black,${preset.fontsize},${WHITE},${WHITE},${preset.outlineColour},${preset.backColour},-1,0,0,0,100,100,0,0,${preset.borderStyle},${preset.outline},${preset.shadow},${pos.alignment},90,90,${pos.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const color = (value: string) => `&H00${value.slice(5,7)}${value.slice(3,5)}${value.slice(1,3)}`;
  const eventStyle = (value: TextStyle, name: string) => {
    const spec = PRESETS[value.preset];
    const pos = POSITIONS[value.position];
    return `Style: ${name},Arial Black,${value.fontSize ?? spec.fontsize},${value.color ? color(value.color) : WHITE},${WHITE},${spec.outlineColour},${spec.backColour},-1,0,0,0,100,100,0,0,${spec.borderStyle},${spec.outline},${spec.shadow},${pos.alignment},90,90,${pos.marginV},1`;
  };
  // Each cue may have a per-shot style, including in the fallback engine.
  const eventIndex = lines.indexOf("[Events]");
  lines.splice(eventIndex - 1, 0, ...events.map((e, i) => eventStyle(e.style ?? style, `Cue${i}`)));
  for (const [i, e] of events.entries()) {
    lines.push(`Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Cue${i},,0,0,0,,${assText(e.text)}`);
  }
  return lines.join("\n") + "\n";
}
