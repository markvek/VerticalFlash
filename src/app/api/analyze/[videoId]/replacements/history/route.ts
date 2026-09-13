import { NextRequest, NextResponse } from "next/server";
import { withProjectEdit } from "@/lib/project-edit-lock";
import { referenceHistory } from "@/lib/reference-selection";
type Context = { params: Promise<{ videoId: string }> };
export async function GET(_request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  try { return NextResponse.json(await referenceHistory(videoId)); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "History unavailable" }, { status: 400 }); }
}
export async function POST(request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  const body = await request.json().catch(() => null);
  if (body?.action !== "undo" && body?.action !== "redo") return NextResponse.json({ error: "Invalid history action" }, { status: 400 });
  return withProjectEdit(videoId, async () => {
    try { return NextResponse.json(await referenceHistory(videoId, body.action)); }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Could not restore replacement" }, { status: 409 }); }
  });
}
