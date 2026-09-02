import { ApiError, GoogleGenAI } from "@google/genai";

// Single source of truth for the model. Do NOT use gemini-2.5-* or
// gemini-1.5-* — the 2.5 family retires Oct 2026.
export const GEMINI_MODEL = "gemini-3.6-flash";

// Video generation (per-shot clip generate/extend) goes through the
// interactions API, which needs the Omni family — not GEMINI_MODEL.
export const GEMINI_VIDEO_MODEL = "gemini-omni-1.1-flash";

export {
  GEMINI_PRICE_IN_PER_M,
  GEMINI_PRICE_OUT_PER_M,
} from "./gemini-pricing";

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured — add it to .env.local (from Google AI Studio)"
    );
  }
  return new GoogleGenAI({ apiKey });
}

export type GeminiErrorKind =
  | "rate_limit"
  | "daily_quota"
  | "unavailable"
  | "fatal";

// Free-tier 429 bodies embed RetryInfo like: "retryDelay":"37s"
function extractRetryAfterMs(message: string): number | undefined {
  const m =
    message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ||
    message.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : undefined;
}

export function classifyGeminiError(err: unknown): {
  kind: GeminiErrorKind;
  retryAfterMs?: number;
} {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof ApiError ? err.status : undefined;

  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(message)) {
    const retryAfterMs = extractRetryAfterMs(message);
    const daily = /PerDay|per day|daily/i.test(message);
    return { kind: daily ? "daily_quota" : "rate_limit", retryAfterMs };
  }
  if (status === 503 || /UNAVAILABLE|overloaded/i.test(message)) {
    return { kind: "unavailable", retryAfterMs: extractRetryAfterMs(message) };
  }
  return { kind: "fatal" };
}
