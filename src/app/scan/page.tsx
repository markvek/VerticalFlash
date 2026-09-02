"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function ScanPage() {
  const router = useRouter();
  const [tiktokUrl, setTiktokUrl] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [keywords, setKeywords] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [millionViewsOnly, setMillionViewsOnly] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!hashtags.trim() && !keywords.trim() && !competitors.trim()) {
      return;
    }

    setIsSubmitting(true);

    const params = new URLSearchParams();
    if (tiktokUrl.trim()) params.set("tiktokUrl", tiktokUrl.trim());
    if (hashtags.trim()) params.set("hashtags", hashtags.trim());
    if (keywords.trim()) params.set("keywords", keywords.trim());
    if (competitors.trim()) params.set("competitors", competitors.trim());
    if (millionViewsOnly) params.set("minViews", "1000000");

    router.push(`/results?${params.toString()}`);
  };

  const hasInput =
    hashtags.trim() || keywords.trim() || competitors.trim();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">TikTok Niche Scanner</h1>
          <p className="mt-2 text-muted-foreground">
            Analyze hashtags, keywords, and competitors to discover niche
            opportunities
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="tiktok-url" className="text-sm font-medium">
              TikTok Profile URL{" "}
              <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              id="tiktok-url"
              type="url"
              placeholder="https://www.tiktok.com/@username"
              value={tiktokUrl}
              onChange={(e) => setTiktokUrl(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="hashtags" className="text-sm font-medium">
              Seed Hashtags
            </label>
            <input
              id="hashtags"
              type="text"
              placeholder="#thriftfashion, #y2kfashion, #styletok"
              value={hashtags}
              onChange={(e) => setHashtags(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Enter hashtags with # symbol, separated by commas
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="keywords" className="text-sm font-medium">
              Seed Keywords
            </label>
            <input
              id="keywords"
              type="text"
              placeholder="thrift transformation, outfit ideas, vintage finds"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Enter search keywords, separated by commas
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="competitors" className="text-sm font-medium">
              Competitor Accounts
            </label>
            <input
              id="competitors"
              type="text"
              placeholder="@thriftqueen, @vintagestyle, @y2kvibes"
              value={competitors}
              onChange={(e) => setCompetitors(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Enter @handles, separated by commas
            </p>
          </div>

          <label
            htmlFor="million-views-only"
            className="flex cursor-pointer items-center gap-2 text-sm font-medium"
          >
            <input
              id="million-views-only"
              type="checkbox"
              checked={millionViewsOnly}
              onChange={(e) => setMillionViewsOnly(e.target.checked)}
              className="size-4 rounded border-input accent-primary"
            />
            Only include videos with 1M+ views
          </label>
          <p className="text-xs text-muted-foreground">
            Videos longer than 25 seconds are always excluded.
          </p>

          <Button
            type="submit"
            className="w-full"
            disabled={!hasInput || isSubmitting}
          >
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Scanning...
              </span>
            ) : (
              "Scan Niche"
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
