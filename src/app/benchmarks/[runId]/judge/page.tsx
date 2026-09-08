import type { Metadata } from "next";
import { BenchmarkJudge } from "@/components/benchmarks/BenchmarkJudge";

export const metadata: Metadata = { title: "Blind Review · VerticalFlash" };

export default async function BenchmarkJudgePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <BenchmarkJudge runId={runId} />;
}
