import { withProjectEdit } from "@/lib/project-edit-lock";
import { textOverlaysPath } from "@/lib/text-overlays-store";
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileAsync } from "@/lib/ffmpeg";
import {
  DEFAULT_TEXT_STYLE,
  TextOverlaysZ,
  ShotOverlayZ,
  type TextWord,
  TextStyleZ,
  type TextOverlays,
} from "@/lib/text-overlays-schema";

async function loadOverlays(videoId: string): Promise<TextOverlays> {
  try {
    const raw = await fs.readFile(textOverlaysPath(videoId), "utf8");
    return TextOverlaysZ.parse(JSON.parse(raw));
  } catch {
    return {
      videoId,
      updatedAt: new Date().toISOString(),
      style: { ...DEFAULT_TEXT_STYLE },
      shots: {},
    };
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  return NextResponse.json(await loadOverlays(videoId));
}

// Save a per-shot text override/toggle ({shot_index, text, include}), clear
// one back to the detected text ({shot_index, reset: true}), or change the
// burn style ({style: {engine?, preset?, position?}})
async function patch(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const stored = await loadOverlays(videoId);

  if (body.shot_index == null && body.style && typeof body.style === "object") {
    const merged = TextStyleZ.safeParse({ ...stored.style, ...body.style });
    if (!merged.success) {
      return NextResponse.json({ error: "Invalid style" }, { status: 400 });
    }
    stored.style = merged.data;
  } else {
    const shotIndex = body.shot_index;
    if (typeof shotIndex !== "number" || !Number.isInteger(shotIndex) || shotIndex < 0) {
      return NextResponse.json(
        { error: "shot_index is required" },
        { status: 400 }
      );
    }
    if (body.reset === true) {
      delete stored.shots[String(shotIndex)];
    } else {
      const entry = ShotOverlayZ.safeParse({ ...stored.shots[String(shotIndex)], ...body });
      if (!entry.success) return NextResponse.json({ error: entry.error.issues.map(i => i.message).join("; ") }, { status: 400 });
      if (entry.data.endOffset != null && entry.data.endOffset <= (entry.data.startOffset ?? 0)) return NextResponse.json({ error: "Text end must follow its start" }, { status: 400 });
      stored.shots[String(shotIndex)] = entry.data;
    }
  }
  stored.updatedAt = new Date().toISOString();

  const path = textOverlaysPath(videoId);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(TextOverlaysZ.parse(stored), null, 2));
  await fs.rename(tmp, path);

  return NextResponse.json(stored);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await context.params;
  return withProjectEdit(videoId, () => patch(request, context));
}

// Explicitly requested alignment; no AI work is started while typing.
export async function POST(request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await context.params;
  if (!/^[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid video" }, { status: 400 });
  let workDir: string | null = null;
  try {
    const { shot_index: index } = await request.json();
    const { AnalysisZ } = await import("@/lib/analysis-schema");
    const { analysisPath } = await import("@/lib/paths");
    const { findDownloadFile } = await import("@/lib/download-files");
    const { shotSources } = await import("@/lib/framing-sources");
    const { transcribeWithWhisperX } = await import("@/lib/transcribe-whisperx");
    const raw = await fs.readFile(analysisPath(videoId), "utf8");
    const analysis = AnalysisZ.parse(JSON.parse(raw));
    const shot = Number.isInteger(index) && index >= 0 ? analysis.shots[index] : null;
    const file = await findDownloadFile(videoId);
    if (!shot || !file) throw new Error("Shot not found");
    const spans = (await shotSources(file.path, analysis))[String(index)];
    const words: TextWord[] = [];
    workDir = await fs.mkdtemp(join(tmpdir(), "vf-text-align-"));
    for (const [spanIndex, span] of spans.entries()) {
      // Align only the selected footage, not an entire long-form upload.
      const audio = join(workDir, `${spanIndex}.wav`);
      await execFileAsync("ffmpeg", ["-v", "error", "-ss", String(span.start), "-i", span.path,
        "-t", String(span.end - span.start), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audio]);
      const result = await transcribeWithWhisperX(audio);
      const base = (shot.source_start ?? shot.start_time) + span.offset;
      for (const w of result.words.filter(w => w.end > 0 && w.start < span.end - span.start && w.end > w.start)) {
        words.push({ text: w.word, start: base + Math.max(0, w.start), end: base + Math.min(span.end - span.start, w.end) });
      }
    }
    if (!words.length) throw new Error("No speech found in this shot. Custom text is still available.");
    return await withProjectEdit(videoId, async () => {
      if (await fs.readFile(analysisPath(videoId), "utf8") !== raw) return NextResponse.json({ error: "The timeline changed during alignment. Select the shot and try again." }, { status: 409 });
      const stored = await loadOverlays(videoId);
      stored.shots[String(index)] = { ...(stored.shots[String(index)] ?? { text: shot.on_screen_text, include: true }), words };
      stored.updatedAt = new Date().toISOString();
      const path = textOverlaysPath(videoId);
      await fs.writeFile(`${path}.tmp`, JSON.stringify(TextOverlaysZ.parse(stored), null, 2));
      await fs.rename(`${path}.tmp`, path);
      return NextResponse.json(stored);
    });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Alignment failed" }, { status: 400 }); }
  finally { if (workDir) await fs.rm(workDir, { recursive: true, force: true }); }
}
export const maxDuration = 1800;
