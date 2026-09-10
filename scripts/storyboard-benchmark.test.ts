import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { StructuredGenerator } from "../src/lib/models/schema";

// Real media, rendering and storage; controlled model responses avoid paid calls.
test(
  "one setup produces four isolated storyboards and applied B-roll previews; failed stages resume",
  { timeout: 240000 },
  async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "vf-storyboard-benchmark-"));
    process.env.DATA_DIR = root;
    process.env.GEMINI_API_KEY = "test-key-never-sent";
    process.env.BENCHMARK_GEMINI_MODELS = "test-a,test-b,test-c,test-d";
    delete process.env.STORYBOARD_DRY_RUN;
    try {
      const paths = await import("../src/lib/paths");
      const { getBrandConfig } = await import("../src/lib/config");
      const {
        createStoryboardBenchmark,
        runStoryboardBenchmark,
        retryStoryboardBenchmark,
      } = await import("../src/lib/storyboard-benchmark");
      const { readBenchmarkRun, addBenchmarkHumanReview } =
        await import("../src/lib/benchmarks");
      const { saveLibrary } = await import("../src/lib/library-store");
      const { validateBrollDecisions } =
        await import("../src/lib/benchmark-broll");
      const { StoryboardZ } = await import("../src/lib/segments-schema");
      await paths.ensureDataDirs();
      execFileSync("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=180x320:r=30:d=6",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=6",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        join(paths.LIBRARY_DIR, "core.mp4"),
      ]);
      execFileSync("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=180x320:r=30:d=6",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        join(paths.LIBRARY_DIR, "broll.mp4"),
      ]);
      const now = new Date().toISOString();
      await saveLibrary({
        lastUpdated: now,
        videos: [
          {
            filename: "core.mp4",
            duration: 6,
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
          {
            filename: "broll.mp4",
            duration: 6,
            tags: [],
            createdAt: now,
            updatedAt: now,
            analysis: {
              analyzedAt: now,
              model: "fixture",
              location: "interior",
              product_present: true,
              product_note: "",
              time_of_day: "midday",
              camera_action: "static",
              category: "product",
              spoken_text: "",
              description: "Red product",
              suggested_tags: ["red"],
            },
          },
        ],
      });
      const input = {
        requestId: randomUUID(),
        title: "Fixture",
        clips: ["core.mp4"],
        timingEngine: "gemini",
        request: {
          count: 1,
          lengths: [6],
          pacing: "fast",
          allow_broll: true,
          brief: "Show the red product",
        },
        brollClips: ["broll.mp4"],
        models: ["test-a", "test-b", "test-c", "test-d"].map((model) => ({
          provider: "gemini",
          model,
        })),
      };
      const run = await createStoryboardBenchmark(input);
      assert.equal((await createStoryboardBenchmark(input)).id, run.id);
      await assert.rejects(
        () => createStoryboardBenchmark({ ...input, title: "Different" }),
        /different setup/,
      );
      const dir = join(paths.BENCHMARKS_DIR, run.id);
      const frozen = JSON.parse(
        await fs.readFile(join(dir, "inputs.json"), "utf8"),
      );
      const masterPath = join(paths.STORYBOARDS_DIR, run.source.filename);
      await fs.copyFile(join(paths.LIBRARY_DIR, "core.mp4"), masterPath);
      const meta = {
        kind: "master",
        title: "Fixture",
        createdAt: now,
        timingEngine: "gemini",
        sourceClips: [],
      };
      await fs.writeFile(`${masterPath}.metadata.json`, JSON.stringify(meta));
      const segments = {
        videoId: run.source.videoId,
        analyzedAt: now,
        model: "fixture",
        timing_source: "gemini",
        whisperx: null,
        words: [],
        sentences: [],
        silences: [],
        full_transcript: "Hook. Product. End.",
        timing_note: null,
        segments: ["Hook.", "Product.", "End."].map((text, i) => ({
          index: i,
          start_time: i * 2,
          end_time: i * 2 + 2,
          start_word: null,
          end_word: null,
          text,
          topic: "product",
          role: i === 0 ? "hook" : i === 2 ? "cta" : "demo",
          hook_score: 5,
          standalone: true,
          on_screen_text_idea: "",
        })),
      };
      await fs.writeFile(
        join(dir, "prepared.json"),
        JSON.stringify({
          ...frozen,
          master: {
            filename: run.source.filename,
            videoId: run.source.videoId,
            duration: 6,
          },
          meta,
          segments,
          images: [],
          brandHash: createHash("sha256")
            .update(JSON.stringify(getBrandConfig()))
            .digest("hex"),
        }),
      );
      const calls: Array<{ model: string; prompt: string }> = [];
      let fail = true;
      const generatorFor =
        (choice: { model: string }): StructuredGenerator =>
        async (request) => {
          calls.push({ model: choice.model, prompt: request.prompt });
          if (request.prompt.startsWith("Choose and apply B-roll")) {
            if (choice.model === "test-d" && fail)
              throw new Error("Fixture provider unavailable");
            return {
              model: choice.model,
              text: JSON.stringify({
                decisions: [
                  {
                    beat: 1,
                    filename: "broll.mp4",
                    clipStart: 1,
                    reason: "The red product illustrates the phrase.",
                  },
                ],
              }),
            };
          }
          return {
            model: choice.model,
            text: JSON.stringify({
              storyboards: [
                {
                  title: "Product story",
                  hook_line: "Hook.",
                  angle: "Show product",
                  target_seconds: 6,
                  beats: ["hook", "main", "end"].map((section, i) => ({
                    section,
                    start_time: i * 2,
                    end_time: i * 2 + 2,
                    on_screen_text: "",
                    show: i === 1 ? "broll" : "source",
                    broll_description: i === 1 ? "Red product" : "",
                    broll_tags: i === 1 ? ["red"] : [],
                  })),
                },
              ],
            }),
          };
        };
      await runStoryboardBenchmark(run.id, generatorFor);
      let finished = (await readBenchmarkRun(run.id))!;
      assert.equal(
        finished.variants.filter((v) => v.status === "ready").length,
        3,
        JSON.stringify(finished.variants.map((v) => v.error)),
      );
      assert.equal(
        finished.variants.filter((v) => v.status === "failed").length,
        1,
      );
      assert.equal(
        new Set(
          calls
            .filter((c) => !c.prompt.startsWith("Choose and apply"))
            .map((c) => c.prompt),
        ).size,
        1,
      );
      const generated = calls.filter(
        (c) => !c.prompt.startsWith("Choose and apply"),
      ).length;
      fail = false;
      await retryStoryboardBenchmark(run.id);
      await runStoryboardBenchmark(run.id, generatorFor);
      finished = (await readBenchmarkRun(run.id))!;
      assert.ok(
        finished.variants.every((v) => v.status === "ready"),
        JSON.stringify(finished.variants.map((v) => v.error)),
      );
      assert.equal(
        calls.filter((c) => !c.prompt.startsWith("Choose and apply")).length,
        generated,
        "retry must reuse completed storyboards",
      );
      assert.equal(
        new Set(finished.variants.map((v) => v.artifact!.storyboard!.id)).size,
        4,
      );
      for (const v of finished.variants) {
        assert.ok((await fs.stat(join(dir, `${v.id}.mp4`))).size > 100);
        const manifest = JSON.parse(
          await fs.readFile(
            join(paths.RENDERS_DIR, `${v.output!.videoId}.render.json`),
            "utf8",
          ),
        );
        assert.equal(manifest.broll[0].filename, "broll.mp4");
        assert.equal(manifest.audio, "original");
        const pixel = execFileSync("ffmpeg", [
          "-v",
          "error",
          "-ss",
          "3",
          "-i",
          join(dir, `${v.id}.mp4`),
          "-frames:v",
          "1",
          "-vf",
          "scale=1:1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
        assert.ok(
          pixel[0] > pixel[2] + 80,
          "the rendered B-roll must visibly replace the blue source with red",
        );
      }
      const sb = StoryboardZ.parse(finished.variants[0].artifact!.storyboard);
      assert.throws(
        () =>
          validateBrollDecisions(
            [{ beat: 1, filename: "other.mp4", clipStart: 0, reason: "bad" }],
            sb,
            frozen.catalog,
          ),
        /eligible/,
      );
      assert.throws(
        () =>
          validateBrollDecisions(
            [{ beat: 1, filename: "broll.mp4", clipStart: 5, reason: "bad" }],
            sb,
            frozen.catalog,
          ),
        /eligible/,
      );
      assert.equal(
        validateBrollDecisions(
          [{ beat: 1, filename: null, clipStart: null, reason: "No fit" }],
          sb,
          frozen.catalog,
        )[0].filename,
        null,
      );
      const offInput = {
        ...input,
        requestId: randomUUID(),
        request: { ...input.request, allow_broll: false },
        brollClips: [],
      };
      const offRun = await createStoryboardBenchmark(offInput);
      const offDir = join(paths.BENCHMARKS_DIR, offRun.id);
      const prepared = JSON.parse(
        await fs.readFile(join(dir, "prepared.json"), "utf8"),
      );
      const offMasterPath = join(paths.STORYBOARDS_DIR, offRun.source.filename);
      await fs.copyFile(masterPath, offMasterPath);
      await fs.writeFile(
        `${offMasterPath}.metadata.json`,
        JSON.stringify(meta),
      );
      await fs.writeFile(
        join(offDir, "prepared.json"),
        JSON.stringify({
          ...prepared,
          master: {
            ...prepared.master,
            filename: offRun.source.filename,
            videoId: offRun.source.videoId,
          },
          segments: { ...segments, videoId: offRun.source.videoId },
          catalog: [],
          images: [],
        }),
      );
      const matchCalls = calls.filter((c) =>
        c.prompt.startsWith("Choose and apply"),
      ).length;
      await runStoryboardBenchmark(offRun.id, generatorFor);
      const offFinished = (await readBenchmarkRun(offRun.id))!;
      assert.ok(
        offFinished.variants.every((v) => v.status === "ready"),
        JSON.stringify(offFinished.variants.map((v) => v.error)),
      );
      assert.equal(
        calls.filter((c) => c.prompt.startsWith("Choose and apply")).length,
        matchCalls,
        "B-roll off must not invoke matching",
      );
      assert.ok(
        offFinished.variants.every((v) => v.artifact!.broll!.length === 0),
      );
      const reviews = finished.variants.map((v) => ({
        variantId: v.id,
        scores: {
          hook: 10,
          pacing: 10,
          clarity: 10,
          polish: 10,
          broll_fit: 10,
        },
        wouldPost: true,
        notes: "",
      }));
      const reviewed = await addBenchmarkHumanReview(run.id, {
        id: randomUUID(),
        createdAt: now,
        reviewer: "Fixture",
        winnerVariantId: finished.variants[0].id,
        reviews,
      });
      assert.equal(reviewed.variants[0].humanScore, 100);
      await assert.rejects(() => retryStoryboardBenchmark(run.id), /locked/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
