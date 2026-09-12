"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ScanResults } from "@/components/data/ScanResults";
import { CandidateSidebar } from "@/components/form/CandidateSidebar";
import { useScanHistory } from "@/app/context/scan-history";
import type { ScanResult } from "@/lib/tikhub";
import type { ScanSeeds } from "@/lib/scan-storage";

function ResultsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { scans, createScan, setCurrentScanId } = useScanHistory();
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const scanId = searchParams.get("scan");
    const hashtags = searchParams.get("hashtags") || "";
    const keywords = searchParams.get("keywords") || "";
    const competitors = searchParams.get("competitors") || "";
    const tiktokUrl = searchParams.get("tiktokUrl") || "";
    const minViews = Number(searchParams.get("minViews")) || 0;

    setError(null);

    // If scan ID provided, load from localStorage
    if (scanId) {
      const scan = scans.find((s) => s.id === scanId);
      if (scan) {
        setCurrentScanId(scanId);
        setData(scan.results);
        setLoading(false);
        return;
      } else {
        setError("Scan not found");
        setLoading(false);
        return;
      }
    }

    // Otherwise, treat as new scan with seed parameters
    if (!hashtags && !keywords && !competitors) {
      setError("No search parameters provided");
      setLoading(false);
      return;
    }

    async function fetchData() {
      try {
        const response = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hashtags,
            keywords,
            competitors,
            tiktokUrl,
            minViews,
          }),
        });

        if (!response.ok) {
          throw new Error((await response.json()).error || "Could not search TikTok. Check the connection and retry.");
        }

        const result: ScanResult = await response.json();

        // Create new scan in history with seed parameters
        const seeds: ScanSeeds = {
          hashtags: hashtags
            ? hashtags.split(",").map((t) => t.trim())
            : [],
          keywords: keywords ? keywords.split(",").map((k) => k.trim()) : [],
          competitors: competitors
            ? competitors.split(",").map((c) => c.trim())
            : [],
          tiktokUrl: tiktokUrl || undefined,
          minViews: minViews || undefined,
        };

        const newScan = createScan(seeds, result);
        setCurrentScanId(newScan.id);
        setData(result);

        // Update URL to use scan ID instead of seed parameters
        router.replace(`/results?scan=${newScan.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [searchParams, scans, createScan, setCurrentScanId, router]);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Main Content */}
      <div className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">
                Niche Scan Results
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Analysis of your TikTok niche based on hashtags, keywords, and
                competitors
              </p>
            </div>
            <Button variant="outline" onClick={() => router.push("/scan")}>
              New Scan
            </Button>
          </div>

          {loading && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="size-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
              <p className="mt-4 text-muted-foreground">
                Scanning TikTok data...
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
              <p className="text-destructive">{error}</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => router.push("/scan")}
              >
                Go Back
              </Button>
            </div>
          )}

          {!loading && !error && data && <>{data.errors?.map((message, i) => <p key={i} role="alert" className="mb-3 text-sm text-amber-600">{message}</p>)}<ScanResults data={data} /></>}
        </div>
      </div>

      {/* Right Sidebar: Candidates */}
      {!loading && !error && <CandidateSidebar />}
    </div>
  );
}

function LoadingFallback() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col items-center justify-center py-16">
        <div className="size-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
        <p className="mt-4 text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

export default function ResultsPage() {
  return (
    <main className="min-h-screen bg-background">
      <Suspense fallback={<LoadingFallback />}>
        <ResultsContent />
      </Suspense>
    </main>
  );
}
