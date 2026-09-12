import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { RENDER_SETTINGS } from "./render-schema";
import type { TextStyle } from "./text-overlays-schema";

// The "png" burn engine: rasterizes each text block to a transparent
// full-width PNG that the renderer composites with ffmpeg's overlay filter.
// Skia falls back to the system emoji font per glyph, so color emoji
// survive — the one thing libass can't do. The visual spec (fonts, sizes,
// margins, positions) mirrors ass-subtitles.ts so switching engines doesn't
// move or restyle the text.

// Full render width: overlay x is always 0 and lines center themselves
const CANVAS_WIDTH = RENDER_SETTINGS.width;
const SIDE_MARGIN = 90; // matches ASS MarginL/MarginR
const FONT_STACK = '"Arial Black", "Helvetica Neue", "Apple Color Emoji"';

interface PngPresetSpec {
  fontsize: number;
  lineGap: number;
  // Rounded per-line box — the part ASS BorderStyle=3 can only fake with
  // square corners
  pill: { pad: number; radius: number; color: string } | null;
  stroke: { width: number; color: string } | null;
  shadow: { offset: number; color: string } | null;
}

// Same trio as PRESETS in ass-subtitles.ts; colors converted from
// &HAABBGGRR (alpha 0x50 ≈ 69% opaque, 0x80 = 50%)
const PRESETS: Record<TextStyle["preset"], PngPresetSpec> = {
  tiktok_box: {
    fontsize: 64,
    lineGap: 6,
    pill: { pad: 16, radius: 16, color: "rgba(0,0,0,0.69)" },
    stroke: null,
    shadow: null,
  },
  outline: {
    fontsize: 68,
    lineGap: 8,
    pill: null,
    stroke: { width: 6, color: "#000000" },
    shadow: null,
  },
  caption_bar: {
    fontsize: 52,
    lineGap: 6,
    pill: null,
    stroke: { width: 4, color: "#000000" },
    shadow: { offset: 3, color: "rgba(0,0,0,0.5)" },
  },
};

// Word-wrap against measured widths; explicit newlines are kept. A single
// word wider than the limit stays on its own overflowing line rather than
// being broken mid-word (mirrors libass).
function wrapLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${current} ${word}`;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

function roundedRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export async function rasterizeTextBlock(
  text: string,
  style: TextStyle
): Promise<Buffer> {
  const preset = PRESETS[style.preset];
  const font = `${style.fontSize ?? preset.fontsize}px ${FONT_STACK}`;

  const measure = createCanvas(1, 1).getContext("2d");
  measure.font = font;
  const pillPad = preset.pill?.pad ?? 0;
  const strokeW = preset.stroke?.width ?? 0;
  const lines = wrapLines(
    measure,
    text,
    CANVAS_WIDTH - 2 * (SIDE_MARGIN + pillPad + strokeW)
  );
  if (lines.length === 0) throw new Error("text block is empty");

  // Font-box metrics keep descenders and emoji inside the pill
  const probe = measure.measureText("Mg🙂");
  const ascent = Math.ceil(probe.fontBoundingBoxAscent);
  const lineHeight = ascent + Math.ceil(probe.fontBoundingBoxDescent);
  const rowHeight = lineHeight + 2 * pillPad;
  // Border strokes straddle the path and shadows fall outside the glyph box
  const bleed = Math.ceil(strokeW + (preset.shadow?.offset ?? 0)) + 2;
  const height =
    lines.length * rowHeight +
    (lines.length - 1) * preset.lineGap +
    2 * bleed;

  const canvas = createCanvas(CANVAS_WIDTH, height);
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const centerX = CANVAS_WIDTH / 2;

  let top = bleed;
  for (const line of lines) {
    const lineWidth = measure.measureText(line).width;
    if (preset.pill) {
      const w = Math.min(lineWidth + 2 * preset.pill.pad, CANVAS_WIDTH);
      ctx.fillStyle = preset.pill.color;
      roundedRectPath(ctx, centerX - w / 2, top, w, rowHeight, preset.pill.radius);
      ctx.fill();
    }
    const baseline = top + pillPad + ascent;
    if (preset.stroke) {
      if (preset.shadow) {
        ctx.shadowColor = preset.shadow.color;
        ctx.shadowOffsetX = preset.shadow.offset;
        ctx.shadowOffsetY = preset.shadow.offset;
      }
      // lineWidth is the full straddle, so this leaves strokeW outside the
      // glyph edge — same as the ASS Outline value
      ctx.lineWidth = preset.stroke.width * 2;
      ctx.lineJoin = "round";
      ctx.strokeStyle = preset.stroke.color;
      ctx.strokeText(line, centerX, baseline);
      ctx.shadowColor = "transparent";
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    ctx.fillStyle = style.color ?? "#ffffff";
    ctx.fillText(line, centerX, baseline);
    top += rowHeight + preset.lineGap;
  }

  return canvas.encode("png");
}

// ffmpeg overlay coordinates for a full-width block image. Vertical margins
// match POSITIONS in ass-subtitles.ts (top text edge 250px down, bottom text
// edge 460px up — inside TikTok's caption/icon safe area).
export function overlayPlacement(style: TextStyle): { x: string; y: string } {
  switch (style.position) {
    case "top":
      return { x: "0", y: "250" };
    case "center":
      return { x: "0", y: "(H-h)/2" };
    case "bottom":
      return { x: "0", y: "H-460-h" };
  }
}
