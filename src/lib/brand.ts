import { z } from "zod";

// Brand configuration: everything the prompts, the clip-library schema, and
// the UI need to know about the product being filmed. Loaded server-side
// from brand.config.json (see config.ts); this module is isomorphic on
// purpose so client components can import the types and the neutral default.

// The two category ids the code relies on: "product_showcase" ranks clips
// as AI-generation references, "other" is the cataloging prompt's fallback.
export const CLIP_CATEGORY_IDS = {
  showcase: "product_showcase",
  other: "other",
} as const;

const REQUIRED_CATEGORY_IDS = Object.values(CLIP_CATEGORY_IDS) as string[];

export const BrandCategoryZ = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "lowercase snake_case id"),
  // Rendered into the cataloging prompt, e.g. "(packing orders/boxes)"
  description: z.string().min(1),
});

export const BrandTagsZ = z.object({
  subject: z.array(z.string()).default([]),
  setting: z.array(z.string()).default([]),
  action: z.array(z.string()).default([]),
  camera: z.array(z.string()).default([]),
});

export const BrandConfigZ = z.object({
  // Brand/account name, used in prompts and UI copy
  name: z.string().min(1),
  product: z.object({
    // Casual noun phrase for copy like "make it about <shortName>"
    shortName: z.string().min(1),
    // One-line product description for the analysis and planning prompts
    description: z.string().min(1),
    // Verbatim sentence for text-to-video prompts; every generated shot
    // must describe the same subject or the clips won't cut together.
    // Defaults to `description`.
    character: z.string().min(1).optional(),
    // When the cataloging model should mark a clip as showing the product
    presenceRule: z.string().min(1),
  }),
  // Footage categories for the clip library. Must include the two ids in
  // CLIP_CATEGORY_IDS; add your own freely.
  categories: z
    .array(BrandCategoryZ)
    .min(2)
    .refine(
      (cs) => REQUIRED_CATEGORY_IDS.every((id) => cs.some((c) => c.id === id)),
      {
        message: `categories must include ${REQUIRED_CATEGORY_IDS.map((id) => `"${id}"`).join(" and ")}`,
      }
    ),
  // Brand-specific tags merged into the generic shot-tag vocabulary. The
  // clip matcher scores exact-string tag intersection, so re-run the tag
  // pass on downloaded videos after changing these.
  tags: BrandTagsZ.default({}),
  // Folder (single path segment under the data root) holding your clips
  libraryDir: z
    .string()
    .regex(/^[\w.-]+$/, "single folder name, no path separators")
    .default("library"),
});

export type BrandConfig = z.infer<typeof BrandConfigZ>;
export type BrandCategory = z.infer<typeof BrandCategoryZ>;

// The subset safe to ship to the browser
export interface PublicBrandConfig {
  name: string;
  productShortName: string;
  libraryDir: string;
}

// Used when no brand.config.json exists so the app still boots
export const DEFAULT_BRAND: BrandConfig = {
  name: "My Brand",
  product: {
    shortName: "the product",
    description: "the brand's product",
    presenceRule: "true ONLY if the brand's product is visible in the frame at any point",
  },
  categories: [
    { id: "product_showcase", description: "deliberately featuring the product" },
    { id: "unboxing", description: "unboxing or first look" },
    { id: "b_roll", description: "scenery/filler" },
    { id: "talking_head", description: "person talking to camera" },
    { id: "other", description: "anything else" },
  ],
  tags: { subject: [], setting: [], action: [], camera: [] },
  libraryDir: "library",
};

export function productCharacter(brand: BrandConfig): string {
  return brand.product.character ?? brand.product.description;
}

export function categoryIds(brand: BrandConfig): [string, ...string[]] {
  const ids = brand.categories.map((c) => c.id);
  return [ids[0], ...ids.slice(1)];
}

export function toPublicBrand(brand: BrandConfig): PublicBrandConfig {
  return {
    name: brand.name,
    productShortName: brand.product.shortName,
    libraryDir: brand.libraryDir,
  };
}
