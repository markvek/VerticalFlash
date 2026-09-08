import { after, NextRequest, NextResponse } from "next/server";
import {
  retryStoryboardBenchmark,
  runStoryboardBenchmark,
} from "@/lib/storyboard-benchmark";
export const maxDuration = 3600;
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  try {
    const { runId } = await params;
    const run = await retryStoryboardBenchmark(runId);
    after(() => runStoryboardBenchmark(runId));
    return NextResponse.json({ run }, { status: 202 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Retry failed" },
      { status: 409 },
    );
  }
}
