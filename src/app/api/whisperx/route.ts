import { NextResponse } from "next/server";
import { detectWhisperX, transcriberDefault, whisperXModel } from "@/lib/whisperx";

// Is the word-level timing engine available? Drives the timing-engine
// radio on the storyboard page.
export async function GET() {
  const detection = await detectWhisperX();
  return NextResponse.json({
    ...detection,
    default: detection.available ? transcriberDefault() : "gemini",
    model: whisperXModel(),
  });
}
