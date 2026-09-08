import { benchmarkWithInterruption } from "@/lib/storyboard-benchmark";
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  HUMAN_SCORE_METRICS,
  HumanVariantReviewZ,
} from "@/lib/benchmark-schema";
import {
  addBenchmarkHumanReview,
  assignBenchmarkVariantOutput,
} from "@/lib/benchmarks";

export const runtime = "nodejs";

const OutputZ = z.object({
  filename: z.string().min(1),
  videoId: z.string().nullable(),
  displayName: z.string().min(1),
});

const PatchBodyZ = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assign_output"),
    variantId: z.string().min(1),
    output: OutputZ.nullable(),
  }),
  z.object({
    action: z.literal("review"),
    reviewer: z.string().max(80).optional(),
    winnerVariantId: z.string().nullable(),
    reviews: z.array(HumanVariantReviewZ).min(1),
  }),
]);

function errorMessage(error: unknown): string {
  return error instanceof z.ZodError
    ? error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")
    : error instanceof Error
      ? error.message
      : "Invalid request";
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const run = await benchmarkWithInterruption(runId);
  if (!run) {
    return NextResponse.json({ error: "Benchmark not found" }, { status: 404 });
  }
  return NextResponse.json({ run, humanScoreMetrics: HUMAN_SCORE_METRICS });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  let body: z.infer<typeof PatchBodyZ>;
  try {
    body = PatchBodyZ.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }

  try {
    if (body.action === "assign_output") {
      const run = await assignBenchmarkVariantOutput(
        runId,
        body.variantId,
        body.output
          ? { ...body.output, assignedAt: new Date().toISOString() }
          : null
      );
      return NextResponse.json({ run });
    }

    const run = await addBenchmarkHumanReview(runId, {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      reviewer: body.reviewer?.trim() || "Reviewer",
      winnerVariantId: body.winnerVariantId,
      reviews: body.reviews,
    });
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
