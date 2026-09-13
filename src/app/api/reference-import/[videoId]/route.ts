import { findDownloadFile } from "@/lib/download-files";
import { after, NextRequest, NextResponse } from "next/server";
import { readReferenceImport, runReferenceImport, startReferenceImport } from "@/lib/reference-import";
export const maxDuration = 600;
type Context = { params: Promise<{ videoId: string }> };
export async function GET(_request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^\d+$/.test(videoId)) return NextResponse.json({ error: "Invalid TikTok ID" }, { status: 400 });
  const job = await readReferenceImport(videoId);
  if (!job && _request.nextUrl.searchParams.has("availability")) {
    const file = await findDownloadFile(videoId);
    return NextResponse.json(file ? { filename: file.filename } : null);
  }
  return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^\d+$/.test(videoId)) return NextResponse.json({ error: "Invalid TikTok ID" }, { status: 400 });
  try {
    const body = await request.json().catch(() => ({}));
    const job = await startReferenceImport(videoId, typeof body.author === "string" ? body.author.slice(0, 80) : undefined);
    after(() => runReferenceImport(videoId));
    return NextResponse.json(job, { status: 202 });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Could not prepare edit" }, { status: 500 }); }
}
