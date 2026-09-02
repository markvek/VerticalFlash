import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { EditNotesZ, editNotesPath, type EditNotes } from "@/lib/edit-notes";

async function loadNotes(videoId: string): Promise<EditNotes> {
  try {
    const raw = await fs.readFile(editNotesPath(videoId), "utf8");
    return EditNotesZ.parse(JSON.parse(raw));
  } catch {
    return { videoId, notes: {}, updatedAt: new Date().toISOString() };
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
  return NextResponse.json(await loadNotes(videoId));
}

// Save/clear the fix note for one shot
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let shotIndex: number;
  let note: string;
  try {
    const body = await request.json();
    shotIndex = body.shot_index;
    note = typeof body.note === "string" ? body.note.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (typeof shotIndex !== "number" || !Number.isInteger(shotIndex)) {
    return NextResponse.json(
      { error: "shot_index is required" },
      { status: 400 }
    );
  }
  if (note.length > 500) {
    return NextResponse.json(
      { error: "Note is too long (max 500 characters)" },
      { status: 400 }
    );
  }

  const stored = await loadNotes(videoId);
  if (note) {
    stored.notes[String(shotIndex)] = note;
  } else {
    delete stored.notes[String(shotIndex)];
  }
  stored.updatedAt = new Date().toISOString();

  const path = editNotesPath(videoId);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(EditNotesZ.parse(stored), null, 2));
  await fs.rename(tmp, path);

  return NextResponse.json(stored);
}
