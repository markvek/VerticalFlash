import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import {
  scanHashtag,
  scanKeyword,
  scanCompetitor,
  type ScanResult,
  type HashtagData,
  type KeywordData,
  type CompetitorData,
  type DiscoveryData,
  type HarvestedVideo,
} from "@/lib/tikhub";
import { buildDiscovery } from "@/lib/expand";

const ScanRequestZ = z.object({
  tiktokUrl: z.string().optional(), hashtags: z.string().optional(), keywords: z.string().optional(),
  competitors: z.string().optional(), expand: z.boolean().optional(), minViews: z.number().nonnegative().optional(),
});

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export async function POST(request: NextRequest) {
  try {
    const body = ScanRequestZ.parse(await request.json());

    const hashtagList = parseCommaSeparated(body.hashtags);
    const keywordList = parseCommaSeparated(body.keywords);
    const competitorList = parseCommaSeparated(body.competitors);
    if (!hashtagList.length && !keywordList.length && !competitorList.length && !body.tiktokUrl?.trim()) return NextResponse.json({ error: "Enter a hashtag, keyword, account, or TikTok URL to search." }, { status: 400 });

    const minViews =
      typeof body.minViews === "number" && body.minViews > 0
        ? body.minViews
        : 0;

    // Run all scans in parallel for each category
    const [hashtagResults, keywordResults, competitorResults] =
      await Promise.all([
        Promise.allSettled(
          hashtagList.map((tag) => scanHashtag(tag, minViews))
        ),
        Promise.allSettled(keywordList.map((kw) => scanKeyword(kw, minViews))),
        Promise.allSettled(
          competitorList.map((comp) => scanCompetitor(comp, minViews))
        ),
      ]);

    // Extract successful results, pool their harvests, and log errors
    const allHarvest: HarvestedVideo[] = [];
    const errors: string[] = [];

    const hashtags: HashtagData[] = [];
    hashtagResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        hashtags.push(result.value.data);
        allHarvest.push(...result.value.harvest);
      } else {
        errors.push(`Could not search hashtag ${hashtagList[index]}. Check the TikHub connection and retry.`);
        console.error(
          `Failed to scan hashtag "${hashtagList[index]}":`,
          result.reason
        );
      }
    });

    const keywords: KeywordData[] = [];
    keywordResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        keywords.push(result.value.data);
        allHarvest.push(...result.value.harvest);
      } else {
        errors.push(`Could not search keyword ${keywordList[index]}. Check the TikHub connection and retry.`);
        console.error(
          `Failed to scan keyword "${keywordList[index]}":`,
          result.reason
        );
      }
    });

    const competitors: CompetitorData[] = [];
    competitorResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        competitors.push(result.value.data);
        allHarvest.push(...result.value.harvest);
      } else {
        errors.push(`Could not search account ${competitorList[index]}. Check the TikHub connection and retry.`);
        console.error(
          `Failed to scan competitor "${competitorList[index]}":`,
          result.reason
        );
      }
    });

    // Follow discovered hashtags outward; a failure here never sinks the scan
    let discovered: DiscoveryData | undefined;
    if (body.expand !== false) {
      try {
        discovered = await buildDiscovery({
          harvest: allHarvest,
          seedTags: hashtagList,
          tiktokUrl: body.tiktokUrl,
          minViews,
        });
      } catch (error) {
        errors.push("Related-topic discovery failed; showing available search results.");
        console.error("Expansion failed:", error);
      }
    }

    const scanResult: ScanResult = {
      hashtags,
      keywords,
      competitors,
      ...(discovered ? { discovered } : {}),
    };

    if (errors.length && !hashtags.length && !keywords.length && !competitors.length) return NextResponse.json({ error: errors.join(" "), errors }, { status: 502 });
    return NextResponse.json({ ...scanResult, errors });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Invalid search inputs" }, { status: 400 });
    console.error("Scan API error:", error);
    return NextResponse.json(
      { error: "Failed to perform niche scan" },
      { status: 500 }
    );
  }
}
