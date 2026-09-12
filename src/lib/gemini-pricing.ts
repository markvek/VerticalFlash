// Pricing per million tokens (Gemini 3.6 Flash), for the cost footer.
// Kept separate from gemini.ts so client components can import it without
// pulling the server-side SDK into the browser bundle.
//
// These figures drift; check https://ai.google.dev/gemini-api/docs/pricing
// and override via env if they are out of date.
export const GEMINI_PRICING_MODEL = "gemini-3.6-flash";
export const GEMINI_PRICE_IN_PER_M = envPrice("NEXT_PUBLIC_GEMINI_PRICE_IN_PER_M") ?? 1.5;
export const GEMINI_PRICE_OUT_PER_M = envPrice("NEXT_PUBLIC_GEMINI_PRICE_OUT_PER_M") ?? 7.5;

// Price per second of generated video (Gemini Omni). There is no default:
// video generation is the one genuinely expensive call in this app, so the
// UI says "pricing not configured" until you set
// NEXT_PUBLIC_GEMINI_VIDEO_PRICE_PER_SEC from the pricing page.
export const GEMINI_OMNI_VIDEO_OUT_PER_SEC: number | null = envPrice(
  "NEXT_PUBLIC_GEMINI_VIDEO_PRICE_PER_SEC"
);

function envPrice(name: string): number | null {
  // NEXT_PUBLIC_* values are inlined at build time, so read them by literal
  // name rather than through a dynamic lookup.
  const raw =
    name === "NEXT_PUBLIC_GEMINI_PRICE_IN_PER_M"
      ? process.env.NEXT_PUBLIC_GEMINI_PRICE_IN_PER_M
      : name === "NEXT_PUBLIC_GEMINI_PRICE_OUT_PER_M"
        ? process.env.NEXT_PUBLIC_GEMINI_PRICE_OUT_PER_M
        : process.env.NEXT_PUBLIC_GEMINI_VIDEO_PRICE_PER_SEC;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
