import { z } from "zod";
import {
  BrollDecisionZ,
  type BrollDecision,
} from "./storyboard-benchmark-schema";
import type { Storyboard } from "./segments-schema";
import type { CatalogSummary } from "./shot-plan";
import type { ModelImage, StructuredGenerator } from "./models/schema";

export function validateBrollDecisions(
  decisions: BrollDecision[],
  storyboard: Storyboard,
  catalog: CatalogSummary[],
) {
  const targets = storyboard.beats
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.show === "broll");
  if (
    decisions.length !== targets.length ||
    new Set(decisions.map((d) => d.beat)).size !== targets.length
  )
    throw new Error("Return one decision for every B-roll beat");
  for (const d of decisions) {
    const beat = storyboard.beats[d.beat];
    if (!beat || beat.show !== "broll" || beat.section !== "main")
      throw new Error("Invalid B-roll beat");
    if (d.filename === null) {
      if (d.clipStart !== null)
        throw new Error("No-match must have a null start");
      continue;
    }
    const clip = catalog.find((c) => c.filename === d.filename);
    if (
      !clip ||
      clip.duration_s == null ||
      d.clipStart == null ||
      d.clipStart < 0 ||
      d.clipStart + beat.end - beat.start > clip.duration_s + 0.001
    )
      throw new Error("B-roll clip or trim is outside the eligible footage");
  }
  return decisions;
}
export async function chooseBenchmarkBroll(
  generate: StructuredGenerator,
  storyboard: Storyboard,
  catalog: CatalogSummary[],
  images: ModelImage[],
) {
  const targets = storyboard.beats
    .map((b, i) => ({
      beat: i,
      phrase: b.text,
      wants: b.broll_hint?.description,
      duration: b.end - b.start,
      show: b.show,
    }))
    .filter((b) => b.show === "broll");
  if (!targets.length) return [];
  const prompt = `Choose and apply B-roll for every target segment. Keep the speaker audible. Select an actual clip from the supplied pool and the best start moment within it. Images are contact sheets in reading order, with timestamps in their labels. Use the visuals and catalog to illustrate the spoken phrase. Choose filename:null and clipStart:null with a reason when nothing fits; do not force weak matches. Never select a clip too short for the full segment. Return {decisions:[{beat,filename,clipStart,reason}]}.\nTargets: ${JSON.stringify(targets)}\nCatalog: ${JSON.stringify(catalog)}`;
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await generate({
      prompt: prompt + error,
      schema: {
        type: "object",
        required: ["decisions"],
        properties: {
          decisions: {
            type: "array",
            items: {
              type: "object",
              required: ["beat", "filename", "clipStart", "reason"],
              properties: {
                beat: { type: "integer" },
                filename: { type: ["string", "null"] },
                clipStart: { type: ["number", "null"] },
                reason: { type: "string" },
              },
            },
          },
        },
      },
      images,
    });
    try {
      return validateBrollDecisions(
        z
          .object({ decisions: z.array(BrollDecisionZ) })
          .parse(JSON.parse(response.text)).decisions,
        storyboard,
        catalog,
      );
    } catch (e) {
      error = `\nRepair the previous invalid response: ${e instanceof Error ? e.message : "Invalid JSON"}`;
    }
  }
  throw new Error(`B-roll matching failed validation.${error}`);
}
