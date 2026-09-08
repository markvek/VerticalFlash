import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  BENCHMARK_PROVIDER_OPTIONS,
  BENCHMARK_STAGE_OPTIONS,
  BenchmarkProviderZ,
  BenchmarkSourceZ,
  BenchmarkStageZ,
} from "@/lib/benchmark-schema";
import { createBenchmarkRun, listBenchmarkRuns } from "@/lib/benchmarks";

export const runtime = "nodejs";

const CreateBodyZ = z.object({
  title: z.string().max(120).optional(),
  source: BenchmarkSourceZ,
  providers: z.array(BenchmarkProviderZ).min(1).optional(),
  stages: z.array(BenchmarkStageZ).min(1).optional(),
});

export async function GET() {
  try {
    return NextResponse.json({
      runs: await listBenchmarkRuns(),
      providerOptions: BENCHMARK_PROVIDER_OPTIONS,
      stageOptions: BENCHMARK_STAGE_OPTIONS,
    });
  } catch (error) {
    console.error("Benchmark list failed:", error);
    return NextResponse.json(
      { error: "Could not load benchmarks" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let body: z.infer<typeof CreateBodyZ>;
  try {
    body = CreateBodyZ.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")
            : "Invalid request",
      },
      { status: 400 }
    );
  }

  try {
    const run = await createBenchmarkRun(body);
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create benchmark" },
      { status: 400 }
    );
  }
}
