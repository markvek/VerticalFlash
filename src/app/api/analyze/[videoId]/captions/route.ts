import { trackedRoute } from "@/lib/tracked-route";
import { projectModel } from "@/lib/models/native";
import { NextRequest, NextResponse } from "next/server";
import { getBrandConfig } from "@/lib/config";
import { promises as fs } from "fs";
import { join } from "path";
import { createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { getGeminiClient, getGeminiModel, GEMINI_MODEL } from "@/lib/gemini";
import { AnalysisZ, type Analysis } from "@/lib/analysis-schema";
import {
  CaptionsZ,
  GeminiCaptionsZ,
  geminiCaptionsResponseSchema,
  type CaptionHashtag,
  type Captions,
  type GeminiCaptions,
} from "@/lib/captions-schema";
import { fetchTagDetail } from "@/lib/tikhub";
import {
  GENERIC_TAG_STOPLIST,
  normalizeTag,
  TAG_ZONE_MIN,
  TAG_ZONE_MAX,
} from "@/lib/expand";
import { ANALYSIS_DIR } from "@/lib/paths";
import { findDownloadFile } from "@/lib/download-files";


// One Gemini text call plus up to ~14 TikHub tag lookups
export const maxDuration = 120;

const MAX_HASHTAGS = 5;
const MAX_SIZED_CANDIDATES = 14;

interface VideoMetadata {
  caption?: string;
  coTags?: Array<{ name: string }>;
  musicTitle?: string;
  musicAuthor?: string;
  playCount?: number;
  likeCount?: number;
}

function captionsPath(videoId: string): string {
  return join(ANALYSIS_DIR, `${videoId}.captions.json`);
}

async function loadAnalysis(videoId: string): Promise<Analysis | null> {
  try {
    const raw = await fs.readFile(
      join(ANALYSIS_DIR, `${videoId}.json`),
      "utf8"
    );
    return AnalysisZ.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readMetadata(videoId: string): Promise<VideoMetadata> {
  try {
    const file = await findDownloadFile(videoId);
    if (!file) return {};
    const raw = await fs.readFile(
      `${file.path}.metadata.json`,
      "utf8"
    );
    return JSON.parse(raw) as VideoMetadata;
  } catch {
    return {};
  }
}

// The creator's concept is a steer, not a replacement for the analysis
const MAX_CONCEPT_LENGTH = 2000;

function buildPrompt(
  analysis: Analysis,
  meta: VideoMetadata,
  concept: string | null
): string {
  const originalTags =
    meta.coTags?.map((t) => `#${t.name}`).join(" ") || "(not available)";
  const onScreenLines = analysis.shots
    .filter((s) => s.on_screen_text)
    .map((s) => `- ${s.on_screen_text}`)
    .join("\n");

  const brand = getBrandConfig();
  return `You are writing the TikTok caption for a REMAKE of a successful video.
The remake is posted by the ${brand.name} brand account (${brand.name}'s product is
${brand.product.description}) and recreates the original shot-for-shot with ${brand.name}
footage.

THE ORIGINAL VIDEO (a "${analysis.format}" format):
- Summary: ${analysis.summary}
- Hook: ${analysis.hook_description}
- Original caption: ${meta.caption || "(not available)"}
- Original hashtags: ${originalTags}
- Music: ${meta.musicTitle || "(unknown)"}${meta.musicAuthor ? ` by ${meta.musicAuthor}` : ""}
- Performance: ${meta.playCount ? `${meta.playCount.toLocaleString()} plays, ${meta.likeCount?.toLocaleString() ?? "?"} likes` : "(unknown)"}
- Content tags: ${analysis.tags.join(", ")}
${onScreenLines ? `- On-screen text in the video:\n${onScreenLines}` : ""}
- Transcript: ${analysis.full_transcript || "(no speech)"}
${
  concept
    ? `
THE CREATOR'S CONCEPT FOR THE REMAKE (follow this direction — it overrides
the original's framing where they differ):
${concept}
`
    : ""
}
Return JSON matching the schema:

1. captions: 3-4 caption options for the ${brand.name} remake, each with a
   different angle. Rules:
   - Sound like a real TikTok creator, NOT a brand ad — lowercase is fine,
     emoji welcome where natural, no corporate voice, no "Check out our…".
   - Match the energy and framing that made the original work (study its
     caption), but make it about ${brand.name} / ${brand.product.shortName}.
   - Keep each under 150 characters. Do NOT include hashtags in the text.
   - angle: 2-4 word label for the approach.

2. hashtag_candidates: 8-12 hashtags this remake could use, best first,
   WITHOUT the # symbol, lowercase. Mix:
   - niche/community tags matching the video's content and audience
     (the product's niche, the original's community),
   - 1-2 format/trend tags if genuinely fitting.
   Do NOT include generic reach tags (fyp, viral, foryou…) — they are
   filtered out. Include an original hashtag only when it truly fits the
   remake.`;
}

async function generateCaptions(
  ai: GoogleGenAI,
  analysis: Analysis,
  meta: VideoMetadata,
  concept: string | null
): Promise<{
  result: GeminiCaptions;
  usage: Record<string, unknown> | undefined;
}> {
  const basePrompt = buildPrompt(analysis, meta, concept);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: Your previous response was rejected (${
            lastError instanceof Error ? lastError.message : "invalid JSON"
          }). Return ONLY valid JSON matching the provided schema.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([prompt]),
      config: {
        responseMimeType: "application/json",
        responseSchema: geminiCaptionsResponseSchema,
      },
    });

    const rawText = response.text ?? "";
    try {
      return {
        result: GeminiCaptionsZ.parse(JSON.parse(rawText)),
        usage: response.usageMetadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `Caption response failed validation (attempt ${attempt + 1}):`,
        error,
        "\nraw:",
        rawText.slice(0, 2000)
      );
    }
  }

  throw new Error(
    `Gemini returned invalid captions after retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function zoneFor(viewCount: number | null): CaptionHashtag["zone"] {
  if (viewCount == null) return "unknown";
  if (viewCount < TAG_ZONE_MIN) return "too-small";
  if (viewCount > TAG_ZONE_MAX) return "too-big";
  return "in";
}

// Zone ranking: the 10M-500M sweet spot first, then relevant-but-small,
// then unverifiable, then mega tags. Ties keep candidate order (original
// tags and Gemini's best-first ordering).
const ZONE_RANK: Record<CaptionHashtag["zone"], number> = {
  in: 0,
  "too-small": 1,
  unknown: 2,
  "too-big": 3,
};

// Merge original + Gemini candidates, size them via TikHub, rank, cap at 5
async function pickHashtags(
  gemini: GeminiCaptions,
  meta: VideoMetadata
): Promise<{ hashtags: CaptionHashtag[]; tikhubChecked: boolean }> {
  const candidates = new Map<
    string,
    { reason: string; source: "original" | "gemini" }
  >();
  for (const t of meta.coTags || []) {
    const name = normalizeTag(t.name);
    if (!name || GENERIC_TAG_STOPLIST.has(name)) continue;
    candidates.set(name, {
      reason: "Used by the original video",
      source: "original",
    });
  }
  for (const c of gemini.hashtag_candidates) {
    const name = normalizeTag(c.tag).replace(/\s+/g, "");
    if (!name || GENERIC_TAG_STOPLIST.has(name)) continue;
    const existing = candidates.get(name);
    if (existing) {
      // Gemini's reason is more specific; the original source label stays
      existing.reason = c.reason;
    } else {
      candidates.set(name, { reason: c.reason, source: "gemini" });
    }
  }

  const entries = Array.from(candidates.entries()).slice(
    0,
    MAX_SIZED_CANDIDATES
  );
  const sized: CaptionHashtag[] = entries.map(([tag, c]) => ({
    tag,
    reason: c.reason,
    source: c.source,
    viewCount: null,
    videoCount: null,
    zone: "unknown" as const,
  }));

  let anyLookupWorked = false;
  if (process.env.TIKHUB_API_KEY) {
    // Low concurrency like the other TikHub call sites; a failed lookup
    // just leaves that tag unverified
    const queue = sized.map((h, i) => i);
    const worker = async () => {
      while (queue.length) {
        const i = queue.shift();
        if (i === undefined) return;
        try {
          const detail = await fetchTagDetail(sized[i].tag);
          sized[i].viewCount = detail.viewCount;
          sized[i].videoCount = detail.videoCount;
          sized[i].zone = zoneFor(detail.viewCount);
          anyLookupWorked = true;
        } catch (error) {
          console.error(`tag sizing failed for #${sized[i].tag}:`, error);
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  const ranked = sized
    .map((h, i) => ({ h, i }))
    .sort((a, b) => ZONE_RANK[a.h.zone] - ZONE_RANK[b.h.zone] || a.i - b.i)
    .map(({ h }) => h);

  return {
    hashtags: ranked.slice(0, MAX_HASHTAGS),
    tikhubChecked: anyLookupWorked,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  try {
    const raw = await fs.readFile(captionsPath(videoId), "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json(
      { error: "No captions generated for this video" },
      { status: 404 }
    );
  }
}

async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> }
) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) {
    return NextResponse.json({ error: "invalid videoId" }, { status: 400 });
  }

  const analysis = await loadAnalysis(videoId);
  if (!analysis) {
    return NextResponse.json(
      { error: "Run the Gemini shot analysis first — no analysis found" },
      { status: 404 }
    );
  }

  let ai: GoogleGenAI;
  try {
    ai = getGeminiClient(await projectModel(videoId));
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Gemini not configured",
      },
      { status: 500 }
    );
  }

  // Optional { concept } body — the creator's direction for the captions
  let concept: string | null = null;
  try {
    const body = await request.json();
    if (typeof body?.concept === "string") {
      concept = body.concept.trim().slice(0, MAX_CONCEPT_LENGTH) || null;
    }
  } catch {
    // No body (or not JSON) — captions come from the analysis alone
  }

  try {
    const meta = await readMetadata(videoId);
    const { result, usage } = await generateCaptions(
      ai,
      analysis,
      meta,
      concept
    );
    const { hashtags, tikhubChecked } = await pickHashtags(result, meta);

    const stored: Captions = CaptionsZ.parse({
      videoId,
      generatedAt: new Date().toISOString(),
      model: getGeminiModel(ai),
      captions: result.captions,
      hashtags,
      tikhubChecked,
      concept,
      usage: {
        promptTokens: (usage?.promptTokenCount as number) ?? undefined,
        outputTokens: (usage?.candidatesTokenCount as number) ?? undefined,
        totalTokens: (usage?.totalTokenCount as number) ?? undefined,
      },
    });

    await fs.writeFile(captionsPath(videoId), JSON.stringify(stored, null, 2));
    return NextResponse.json(stored);
  } catch (error) {
    console.error("caption generation failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Caption generation failed",
      },
      { status: 500 }
    );
  }
}

export const POST = trackedRoute("Write post captions", handlePost);
