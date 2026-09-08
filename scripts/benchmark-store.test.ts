import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function loadBenchmarksModule(dataDir: string) {
  process.env.DATA_DIR = dataDir;
  return import("../src/lib/benchmarks");
}

test("benchmark runs lock providers, assign outputs, and accept blind reviews", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vf-benchmarks-"));
  try {
    const benchmarks = await loadBenchmarksModule(dataDir);
    const run = await benchmarks.createBenchmarkRun({
      title: "Hook comparison",
      source: {
        filename: "source.mp4",
        videoId: "source",
        displayName: "Source",
        durationSeconds: 28,
      },
      providers: ["gemini", "openai", "claude", "grok"],
      stages: ["tagging", "matching", "storyboarding", "editing_broll"],
    });

    assert.equal(run.status, "draft");
    assert.deepEqual(
      run.variants.map((variant) => variant.blindLabel),
      ["Variant A", "Variant B", "Variant C", "Variant D"]
    );
    assert.equal(run.fairness.sameRendererRequired, true);

    await assert.rejects(
      () =>
        benchmarks.createBenchmarkRun({
          source: {
            filename: "../source.mp4",
            videoId: "source",
            displayName: "Source",
            durationSeconds: 28,
          },
        }),
      /Invalid/
    );

    const ready = await benchmarks.assignBenchmarkVariantOutput(
      run.id,
      run.variants[0].id,
      {
        filename: "gemini-output.mp4",
        videoId: "gemini-output",
        displayName: "Gemini output",
        assignedAt: new Date().toISOString(),
      }
    );
    assert.equal(ready.status, "ready");
    assert.equal(ready.variants[0].status, "ready");

    await assert.rejects(
      () =>
        benchmarks.addBenchmarkHumanReview(ready.id, {
          id: "review-1",
          createdAt: new Date().toISOString(),
          reviewer: "Reviewer",
          winnerVariantId: ready.variants[1].id,
          reviews: [],
        }),
      /Review every ready variant|Array must contain/
    );

    const reviewed = await benchmarks.addBenchmarkHumanReview(ready.id, {
      id: "review-1",
      createdAt: new Date().toISOString(),
      reviewer: "Reviewer",
      winnerVariantId: ready.variants[0].id,
      reviews: [
        {
          variantId: ready.variants[0].id,
          scores: {
            hook: 9,
            pacing: 8,
            clarity: 8,
            polish: 7,
            broll_fit: 8,
          },
          wouldPost: true,
          notes: "Strong first three seconds.",
        },
      ],
    });
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.humanReviews.length, 1);
    assert.equal(reviewed.variants[0].humanScore, 85);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
