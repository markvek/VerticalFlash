import type { Metadata } from "next";
import { BenchmarkDashboard } from "@/components/benchmarks/BenchmarkDashboard";

export const metadata: Metadata = { title: "Benchmarks · VerticalFlash" };

export default function BenchmarksPage() {
  return <BenchmarkDashboard />;
}
