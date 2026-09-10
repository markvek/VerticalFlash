import { checkedModelOptions } from "@/lib/models/providers";
import { StoryboardBenchmarkInputZ } from "@/lib/storyboard-benchmark-schema";
import { modelId } from "@/lib/models/schema";
import { after, NextRequest, NextResponse } from "next/server";
import {
  createStoryboardBenchmark,
  runStoryboardBenchmark,
} from "@/lib/storyboard-benchmark";
export const runtime = "nodejs";
export const maxDuration = 3600;
export async function POST(request: NextRequest) {
  try {
    const input = StoryboardBenchmarkInputZ.parse(await request.json());
    const options = await checkedModelOptions();
    for (const model of input.models) {
      const option = options.find((o) => o.id === modelId(model));
      if (!option?.available)
        throw new Error(
          option?.reason || `Model is not configured: ${modelId(model)}`,
        );
    }
    const run = await createStoryboardBenchmark(input);
    if (run.execution?.status === "queued") after(() => runStoryboardBenchmark(run.id));
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not start benchmark",
      },
      { status: 400 },
    );
  }
}
