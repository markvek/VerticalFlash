import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { AnalysisZ } from "@/lib/analysis-schema";
import { analysisPath } from "@/lib/paths";
import { findDownloadFile } from "@/lib/download-files";
import { FramingDocumentZ } from "@/lib/framing-schema";
import { readFraming, writeFraming } from "@/lib/framing-store";
import { shotSources } from "@/lib/framing-sources";
import { previewSources } from "@/lib/framing-plan";

type Context = { params: Promise<{ videoId: string }> };
export async function GET(_request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  try {
    const file = await findDownloadFile(videoId);
    if (!file) return NextResponse.json({ error: "Video not found" }, { status: 404 });
    const analysis = AnalysisZ.parse(JSON.parse(await fs.readFile(analysisPath(videoId), "utf8")));
    const sources = await previewSources(videoId, file.path, analysis, await shotSources(file.path, analysis));
    return NextResponse.json({ document: await readFraming(videoId), sources: Object.fromEntries(
      Object.entries(sources).map(([key, spans]) => [key, spans.map(s => ({ url: s.url, start: s.start, end: s.end, offset: s.offset, warning: s.warning, playback: s.playback }))])
    ) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cannot load framing" }, { status: 500 });
  }
}
export async function PATCH(request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  const body = await request.json().catch(() => null);
  const parsed = FramingDocumentZ.safeParse(body);
  if (!parsed.success || parsed.data.videoId !== videoId) return NextResponse.json({ error: "Invalid framing settings" }, { status: 400 });
  if (!await findDownloadFile(videoId)) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  try {
    return NextResponse.json(await writeFraming(parsed.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cannot save framing";
    return NextResponse.json({ error: message }, { status: message.includes("another editor") ? 409 : 500 });
  }
}
