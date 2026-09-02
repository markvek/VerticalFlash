import type { BrandConfig } from "./brand";

// Controlled vocabulary for the shot tag pass (round 2 of TikTok analysis).
//
// The clip matcher scores exact-string tag intersection (trim + lowercase,
// no stemming or synonyms), so these terms are seeded to intersect the tags
// already present on library clips. Near-duplicate pairs like
// "interior"/"car interior" are both listed on purpose — the tag prompt asks
// for every fitting tag, so either spelling on the library side still
// matches. Adding terms is cheap; renaming one silently breaks matching
// against clips tagged with the old spelling.
//
// Brand-specific terms (the product itself, its typical settings) come from
// brand.config.json and are merged in by getTagFacets().
export const TAG_FACETS = {
  subject: [
    "product",
    "packaging",
    "hand",
    "person",
    "phone",
    "text overlay",
  ],
  setting: [
    "interior",
    "exterior",
    "store",
    "store shelf",
    "home",
    "road",
    "night",
    "daytime",
  ],
  action: [
    "driving",
    "unboxing",
    "product showcase",
    "placing product",
    "hand held product",
    "shopping",
    "talking to camera",
    "b-roll",
    "reveal",
  ],
  camera: [
    "static shot",
    "stable shot",
    "handheld",
    "pan left",
    "pan right",
    "tilt up",
    "tilt down",
    "zoom in",
    "zoom out",
    "close up",
    "wide shot",
    "pov",
    "tracking shot",
    "screen recording",
  ],
} as const;

export type TagFacet = keyof typeof TAG_FACETS;

const FACETS = Object.keys(TAG_FACETS) as TagFacet[];

// Generic vocabulary plus the brand's own terms, deduplicated per facet
export function getTagFacets(brand: BrandConfig): Record<TagFacet, string[]> {
  const merged = {} as Record<TagFacet, string[]>;
  for (const facet of FACETS) {
    merged[facet] = Array.from(
      new Set([...brand.tags[facet], ...TAG_FACETS[facet]])
    );
  }
  return merged;
}
