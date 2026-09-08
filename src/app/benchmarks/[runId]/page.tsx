import type { Metadata } from "next";
import { BenchmarkRunBoard } from "@/components/benchmarks/BenchmarkRunBoard";

export const metadata: Metadata = { title: "Benchmark Run · VerticalFlash" };

export default async function BenchmarkRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <BenchmarkRunBoard runId={runId} />;
}
