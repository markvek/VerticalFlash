import { NextRequest, NextResponse } from "next/server";
import {
  loadGenerations,
  mutateGenerations,
  getOrCreateShot,
} from "@/lib/generation-store";

// Per-shot AI generation state: GET the sidecar, PATCH one shot's prompt

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }
  return NextResponse.json(await loadGenerations(videoId));
}

// Save the user's edited generation prompt for one shot
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  let shotIndex: number;
  let prompt: string;
  try {
    const body = await request.json();
    shotIndex = body.shot_index;
    prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (typeof shotIndex !== "number" || !Number.isInteger(shotIndex)) {
    return NextResponse.json(
      { error: "shot_index is required" },
      { status: 400 }
    );
  }
  if (prompt.length > 4000) {
    return NextResponse.json(
      { error: "Prompt is too long (max 4000 characters)" },
      { status: 400 }
    );
  }

  const generations = await mutateGenerations(videoId, current => {
  const shot = getOrCreateShot(current, shotIndex);
  shot.prompt = prompt;
  // An edited prompt survives batch re-drafts; clearing it hands the shot
  // back to the next draft pass
  shot.prompt_source = prompt ? "user" : "gemini";
  });

  return NextResponse.json(generations);
}
