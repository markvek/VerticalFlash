import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import {
  DEFAULT_TEXT_STYLE,
  TextOverlaysZ,
  TextStyleZ,
  textOverlaysPath,
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
export async function PATCH(
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

  if (body.style && typeof body.style === "object") {
    const merged = TextStyleZ.safeParse({ ...stored.style, ...body.style });
    if (!merged.success) {
      return NextResponse.json({ error: "Invalid style" }, { status: 400 });
    }
    stored.style = merged.data;
  } else {
    const shotIndex = body.shot_index;
    if (typeof shotIndex !== "number" || !Number.isInteger(shotIndex)) {
      return NextResponse.json(
        { error: "shot_index is required" },
        { status: 400 }
      );
    }
    if (body.reset === true) {
      delete stored.shots[String(shotIndex)];
    } else {
      const text = typeof body.text === "string" ? body.text.trim() : null;
      const include = typeof body.include === "boolean" ? body.include : null;
      if (text == null || include == null) {
        return NextResponse.json(
          { error: "text and include are required" },
          { status: 400 }
        );
      }
      if (text.length > 500) {
        return NextResponse.json(
          { error: "Text is too long (max 500 characters)" },
          { status: 400 }
        );
      }
      stored.shots[String(shotIndex)] = { text, include };
    }
  }
  stored.updatedAt = new Date().toISOString();

  const path = textOverlaysPath(videoId);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(TextOverlaysZ.parse(stored), null, 2));
  await fs.rename(tmp, path);

  return NextResponse.json(stored);
}
