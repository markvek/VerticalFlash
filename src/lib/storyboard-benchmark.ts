import { createHash, randomUUID } from "crypto";
import { createReadStream, promises as fs } from "fs";
import { join } from "path";
import {
  BENCHMARKS_DIR,
  analysisPath,
  sidecarPath,
  STORYBOARDS_DIR,
} from "./paths";
import { getBrandConfig } from "./config";
import { modelGenerator, assertModelAvailable } from "./models/providers";
import {
  modelId,
  type ModelChoice,
  type ModelImage,
  type StructuredGenerator,
} from "./models/schema";
import { StoryboardBenchmarkInputZ } from "./storyboard-benchmark-schema";
import {
  writeRun,
  readBenchmarkRun,
  mutateBenchmark,
  withBenchmarkLock,
  setBenchmarkAiReview,
} from "./benchmarks";
import { judgeStoryboardBenchmark } from "./benchmark-ai-judge";
import { BenchmarkRunZ, type BenchmarkRun } from "./benchmark-schema";
import { findLibraryFile, loadLibrary } from "./library-store";
import { loadCatalogSummary, type CatalogSummary } from "./shot-plan";
import { ensureFfmpeg, execFileAsync } from "./ffmpeg";
import { assembleMaster, probeDuration } from "./master-assemble";
import { analyzeAndStoreMaster, readMasterSegments } from "./master-analyze";
import { getGeminiClient } from "./gemini";
import { readProjectMeta, type MasterProjectMeta } from "./project-meta";
import { generateStoryboards } from "./storyboard-plan";
import { writeStoryboards, readStoryboards } from "./storyboard-store";
import { buildCutdown, recommendationsFromCutdown } from "./cutdown-build";
import { chooseBenchmarkBroll } from "./benchmark-broll";
import { writeBrollTrack } from "./broll-store";
import { renderRemake, type BrollRenderSegment } from "./render-remake";
import { ShotRecommendationsZ } from "./recommendation-schema";
import { AnalysisZ } from "./analysis-schema";
import type { MasterSegments } from "./segments-schema";

const globals = globalThis as typeof globalThis & {
  storyboardBenchmarkWorker?: string;
  storyboardBenchmarkRunning?: Set<string>;
};
export const benchmarkWorkerId = (globals.storyboardBenchmarkWorker ??=
  randomUUID());
const running = (globals.storyboardBenchmarkRunning ??= new Set<string>());
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest("hex");
}
function directory(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid benchmark id");
  return join(BENCHMARKS_DIR, id);
}
async function atomicJson(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data));
  await fs.rename(temp, path);
}
interface Prepared {
  master: { filename: string; videoId: string; duration: number };
  meta: MasterProjectMeta;
  segments: MasterSegments;
  catalog: CatalogSummary[];
  images: ModelImage[];
  hashes: Record<string, string>;
  brandHash: string;
}
async function checkInputs(p: Prepared) {
  if (digest(JSON.stringify(getBrandConfig())) !== p.brandHash)
    throw new Error("Brand settings changed; start a new benchmark");
  for (const [path, hash] of Object.entries(p.hashes))
    if ((await hashFile(path)) !== hash)
      throw new Error("Source footage changed; start a new benchmark");
}
export async function createStoryboardBenchmark(
  raw: unknown,
): Promise<BenchmarkRun> {
  const input = StoryboardBenchmarkInputZ.parse(raw);
  return withBenchmarkLock(input.requestId, async () => {
    const existing = await readBenchmarkRun(input.requestId);
    if (existing) {
      if (JSON.stringify(existing.execution?.input) !== JSON.stringify(input))
        throw new Error("Request ID already belongs to a different setup");
      return existing;
    }
    input.models.forEach(assertModelAvailable);
    if (process.env.STORYBOARD_DRY_RUN === "1")
      throw new Error(
        "Turn off STORYBOARD_DRY_RUN before starting a model benchmark",
      );
    getGeminiClient(); // Shared transcript preparation is explicitly Gemini-backed.
    await ensureFfmpeg();
    const catalog = await loadCatalogSummary();
    for (const clip of [...input.clips, ...input.brollClips]) {
      if (!(await findLibraryFile(clip)))
        throw new Error(`Clip not found: ${clip}`);
    }
    const now = new Date().toISOString();
    const masterId = `master-${input.requestId}`;
    const variants = input.models
      .map((choice) => ({ choice, random: randomUUID() }))
      .sort((a, b) => a.random.localeCompare(b.random))
      .map(({ choice }, i) => ({
        id: randomUUID(),
        provider: choice.provider,
        model: choice.model,
        blindLabel: `Variant ${String.fromCharCode(65 + i)}`,
        status: "waiting",
        output: null,
        technicalScore: null,
        aiJudgeScore: null,
        humanScore: null,
        error: null,
        artifact: { stage: "queued" },
      }));
    const run = BenchmarkRunZ.parse({
      id: input.requestId,
      title: input.title,
      createdAt: now,
      updatedAt: now,
      status: "draft",
      source: {
        filename: `${masterId}.mp4`,
        videoId: masterId,
        displayName: input.title,
        durationSeconds: null,
      },
      providers: [...new Set(input.models.map((m) => m.provider))],
      stages: input.request.allow_broll
        ? ["storyboarding", "matching", "editing_broll"]
        : ["storyboarding"],
      fairness: {
        inputLockedAt: now,
        blindLabelsLocked: true,
        sameRendererRequired: true,
        samePromptContractRequired: true,
      },
      variants,
      humanReviews: [],
      execution: {
        input,
        workerId: benchmarkWorkerId,
        status: "queued",
        error: null,
        inputHash: null,
        preparationModel: null,
      },
    });
    await fs.mkdir(directory(run.id), { recursive: true });
    // Freeze metadata and file fingerprints at submission, before any model work.
    const hashes: Record<string, string> = {};
    for (const name of [...input.clips, ...input.brollClips])
      hashes[(await findLibraryFile(name))!] = await hashFile(
        (await findLibraryFile(name))!,
      );
    await atomicJson(join(directory(run.id), "inputs.json"), {
      hashes,
      brandHash: digest(JSON.stringify(getBrandConfig())),
      catalog: catalog.filter((c) => input.brollClips.includes(c.filename)),
    });
    return writeRun(run);
  });
}
async function prepare(run: BenchmarkRun): Promise<Prepared> {
  const path = join(directory(run.id), "prepared.json");
  try {
    const p = JSON.parse(await fs.readFile(path, "utf8")) as Prepared;
    await checkInputs(p);
    return p;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const input = run.execution!.input;
  const frozen = JSON.parse(
    await fs.readFile(join(directory(run.id), "inputs.json"), "utf8"),
  ) as Pick<Prepared, "hashes" | "brandHash" | "catalog">;
  await checkInputs({ ...frozen } as Prepared);
  const masterId = run.source.videoId!;
  const masterPath = join(STORYBOARDS_DIR, run.source.filename);
  let meta = await readProjectMeta(masterPath);
  let duration =
    meta?.kind === "master" ? await probeDuration(masterPath) : null;
  if (meta?.kind !== "master" || !duration) {
    const master = await assembleMaster(
      {
        clips: input.clips,
        title: input.title,
        timingEngine: input.timingEngine,
      },
      masterId,
    );
    duration = master.duration;
    meta = await readProjectMeta(masterPath);
  }
  if (meta?.kind !== "master") throw new Error("Master metadata is missing");
  let segments = await readMasterSegments(masterId);
  if (!segments) {
    await analyzeAndStoreMaster(
      getGeminiClient(),
      masterPath,
      masterId,
      meta,
      duration,
    );
    segments = await readMasterSegments(masterId);
  }
  if (!segments) throw new Error("Source analysis produced no segments");
  // Analyze missing library descriptions once for all four models. Persist each
  // addition so a later preparation retry does not repeat completed analysis.
  for (const filename of input.brollClips) {
    if (frozen.catalog.some((c) => c.filename === filename && c.duration_s))
      continue;
    const { analyzeLibraryClip } = await import("./library-analyze");
    await analyzeLibraryClip(filename);
    const clip = (await loadCatalogSummary()).find(
      (c) => c.filename === filename,
    );
    if (!clip)
      throw new Error(`Could not prepare B-roll metadata: ${filename}`);
    clip.duration_s ??= await probeDuration((await findLibraryFile(filename))!);
    if (!clip.duration_s)
      throw new Error(`Could not read B-roll duration: ${filename}`);
    frozen.catalog = [
      ...frozen.catalog.filter((c) => c.filename !== filename),
      clip,
    ];
    await atomicJson(join(directory(run.id), "inputs.json"), frozen);
  }
  // Preserve the user's pool order after preparation.
  frozen.catalog.sort(
    (a, b) =>
      input.brollClips.indexOf(a.filename) -
      input.brollClips.indexOf(b.filename),
  );
  const images: ModelImage[] = [];
  for (let i = 0; i < frozen.catalog.length; i++) {
    const clip = frozen.catalog[i];
    const clipPath = (await findLibraryFile(clip.filename))!;
    const imagePath = join(directory(run.id), `broll-${i}.jpg`);
    await execFileAsync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      clipPath,
      "-vf",
      `fps=${4 / clip.duration_s!},scale=384:-2,tile=2x2`,
      "-frames:v",
      "1",
      imagePath,
    ]);
    images.push({
      label: `${clip.filename}: four frames in reading order near ${[0.125, 0.375, 0.625, 0.875].map((f) => (f * clip.duration_s!).toFixed(2)).join(", ")} seconds.`,
      data: (await fs.readFile(imagePath)).toString("base64"),
    });
  }
  const hashes = { ...frozen.hashes, [masterPath]: await hashFile(masterPath) };
  const p: Prepared = {
    ...frozen,
    hashes,
    master: { filename: run.source.filename, videoId: masterId, duration },
    meta,
    segments,
    images,
  };
  await checkInputs(p);
  await atomicJson(path, p);
  return p;
}
async function executeVariant(
  runId: string,
  variantId: string,
  p: Prepared,
  generatorFor: (choice: ModelChoice) => StructuredGenerator,
) {
  let run = (await readBenchmarkRun(runId))!;
  let variant = run.variants.find((v) => v.id === variantId)!;
  if (variant.status === "ready") return;
  const started = Date.now();
  const usage = variant.artifact?.usage ?? [];
  const update = async (
    stage: NonNullable<typeof variant.artifact>["stage"],
    patch: Partial<NonNullable<typeof variant.artifact>> = {},
  ) => {
    run = await mutateBenchmark(runId, (r) => {
      const v = r.variants.find((v) => v.id === variantId)!;
      v.status = "running";
      v.error = null;
      v.artifact = { ...v.artifact, ...patch, stage, usage: [...usage] };
    });
    variant = run.variants.find((v) => v.id === variantId)!;
  };
  try {
    await checkInputs(p);
    const choice = { provider: variant.provider, model: variant.model! };
    const provider = generatorFor(choice);
    const generate: StructuredGenerator = async (request) => {
      const result = await provider(request);
      usage.push({
        model: result.model,
        promptTokens: result.promptTokenCount,
        outputTokens: result.candidatesTokenCount,
      });
      return result;
    };
    if (!variant.artifact?.storyboard) {
      await update("storyboarding");
      const doc = await generateStoryboards(
        null,
        p.segments,
        run.execution!.input.request,
        p.master.duration,
        p.catalog,
        generate,
        modelId(choice),
      );
      if (doc.storyboards.length !== 1)
        throw new Error("Expected exactly one storyboard per model");
      // Stable per-variant IDs make retries independent of other model outputs.
      doc.storyboards[0].id = variantId;
      const storyboard = doc.storyboards[0];
      const total = storyboard.beats.reduce((n, b) => n + b.end - b.start, 0);
      if (
        Math.abs(total - storyboard.target_seconds) >
        storyboard.target_seconds * 0.1 + 0.1
      )
        throw new Error(
          "Storyboard duration is outside the shared target tolerance",
        );
      const saved = await readStoryboards(p.master.videoId);
      if (!saved?.storyboards.some((s) => s.id === variantId))
        await writeStoryboards(doc);
      await update("building", { storyboard });
    }
    const storyboard = variant.artifact!.storyboard!;
    if (!variant.artifact!.edit) {
      await update("building");
      const edit = await buildCutdown({
        masterPath: join(STORYBOARDS_DIR, p.master.filename),
        masterId: p.master.videoId,
        masterFilename: p.master.filename,
        masterMeta: p.meta,
        segments: p.segments,
        storyboard,
      });
      await update("matching", { edit });
    }
    if (!variant.artifact!.broll) {
      await update("matching");
      const broll = run.execution!.input.request.allow_broll
        ? await chooseBenchmarkBroll(generate, storyboard, p.catalog, p.images)
        : [];
      await update("rendering", { broll });
    }
    const edit = variant.artifact!.edit!;
    const { findDownloadFile } = await import("./download-files");
    const file = (await findDownloadFile(edit.videoId))!;
    const meta = await readProjectMeta(file.path);
    if (meta?.kind !== "cutdown") throw new Error("Cutdown metadata missing");
    const analysis = AnalysisZ.parse(
      JSON.parse(await fs.readFile(analysisPath(edit.videoId), "utf8")),
    );
    const recs = ShotRecommendationsZ.parse(
      recommendationsFromCutdown(edit.videoId, meta),
    );
    recs.shots.forEach((s) => {
      s.keep_source = true;
    }); // B-roll is an overlay; never replace speech/source slots.
    await atomicJson(sidecarPath(edit.videoId, "recommendations"), recs);
    const broll: BrollRenderSegment[] = [];
    for (const d of variant.artifact!.broll!) {
      if (!d.filename) continue;
      const beat = meta.beats[d.beat];
      const clip = p.catalog.find((c) => c.filename === d.filename)!;
      if (d.clipStart! + beat.end - beat.start > clip.duration_s! + 0.1)
        throw new Error("Rendered B-roll interval exceeds clip duration");
      broll.push({
        id: `${variantId}-${d.beat}`,
        filename: d.filename,
        start: beat.start,
        end: beat.end,
        clip_start: d.clipStart,
        phrase: beat.text,
      });
    }
    await writeBrollTrack({
      videoId: edit.videoId,
      updatedAt: new Date().toISOString(),
      model: modelId(choice),
      segments: broll.map((b) => {
        const d = variant.artifact!.broll!.find(
          (d) => `${variantId}-${d.beat}` === b.id,
        )!;
        return {
          id: b.id,
          anchor: {
            kind: "offset",
            shot_index: d.beat,
            offset: 0,
            duration: b.end - b.start,
          },
          clip: {
            filename: b.filename,
            clip_start: b.clip_start,
            source: "library",
          },
          status: "placed",
          phrase: b.phrase,
          description: d.reason,
          candidates: [],
          createdAt: new Date().toISOString(),
        };
      }),
    });
    await update("rendering");
    await checkInputs(p);
    const manifest = await renderRemake({
      videoId: edit.videoId,
      sourceVideo: edit.filename,
      analysis,
      recs,
      library: await loadLibrary(),
      editNotes: {},
      audio: "original",
      burnText: analysis.shots.some((s) => s.on_screen_text.trim()),
      broll,
    });
    if (manifest.broll?.length !== broll.length || manifest.warnings.length)
      throw new Error(
        `Preview did not render faithfully: ${manifest.warnings.join("; ") || "missing B-roll"}`,
      );
    await checkInputs(p);
    // Immutable preview is served separately from the editable project's render.
    const { renderVideoPath } = await import("./render-remake");
    await fs.copyFile(
      renderVideoPath(edit.videoId),
      join(directory(runId), `${variantId}.mp4`),
    );
    await mutateBenchmark(runId, (r) => {
      const v = r.variants.find((v) => v.id === variantId)!;
      v.status = "ready";
      v.error = null;
      v.output = {
        filename: edit.filename,
        videoId: edit.videoId,
        displayName: edit.displayName,
        assignedAt: new Date().toISOString(),
      };
      v.artifact = {
        ...v.artifact,
        stage: "ready",
        usage,
        elapsedMs: (v.artifact?.elapsedMs ?? 0) + Date.now() - started,
      };
    });
  } catch (e) {
    await mutateBenchmark(runId, (r) => {
      const v = r.variants.find((v) => v.id === variantId)!;
      v.status = "failed";
      v.error = e instanceof Error ? e.message : "Variant failed";
      v.artifact = {
        ...v.artifact,
        stage: "failed",
        usage,
        elapsedMs: (v.artifact?.elapsedMs ?? 0) + Date.now() - started,
      };
    });
  }
}
export async function runStoryboardBenchmark(
  id: string,
  generatorFor: (choice: ModelChoice) => StructuredGenerator = modelGenerator,
) {
  if (running.has(id)) return;
  running.add(id);
  try {
    let run = (await readBenchmarkRun(id))!;
    if (!run?.execution || run.execution.status === "complete") return;
    await mutateBenchmark(id, (r) => {
      r.execution!.status = "preparing";
      r.execution!.workerId = benchmarkWorkerId;
      r.execution!.error = null;
    });
    const prepared = await prepare(run);
    run = await mutateBenchmark(id, (r) => {
      r.execution!.status = "running";
      r.execution!.inputHash = digest(JSON.stringify(prepared));
      r.execution!.preparationModel = prepared.segments.model;
      r.source.durationSeconds = prepared.master.duration;
    });
    const queue = run.variants
      .filter((v) => v.status !== "ready")
      .map((v) => v.id);
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (queue.length) {
          const next = queue.shift();
          if (next) await executeVariant(id, next, prepared, generatorFor);
        }
      }),
    );
    // Advisory AI judge runs before we flip to "complete" so the results page
    // (which stops polling on completion) shows its scores right away. Never
    // let a judge failure fail the run.
    try {
      const finished = await readBenchmarkRun(id);
      const review = finished ? await judgeStoryboardBenchmark(finished) : null;
      if (review) await setBenchmarkAiReview(id, review);
    } catch (judgeError) {
      console.error("AI judge failed", judgeError);
    }
    await mutateBenchmark(id, (r) => {
      r.execution!.status = "complete";
    });
  } catch (e) {
    await mutateBenchmark(id, (r) => {
      r.execution!.status = "failed";
      r.execution!.error =
        e instanceof Error ? e.message : "Preparation failed";
    });
  } finally {
    running.delete(id);
  }
}
export async function benchmarkWithInterruption(id: string) {
  const run = await readBenchmarkRun(id);
  if (
    run?.execution &&
    !["complete", "failed"].includes(run.execution.status) &&
    run.execution.workerId !== benchmarkWorkerId
  ) {
    return mutateBenchmark(id, (r) => {
      r.execution!.status = "failed";
      r.execution!.error =
        "Processing was interrupted by a server restart. Retry to resume.";
    });
  }
  return run;
}
export async function retryStoryboardBenchmark(id: string) {
  if (running.has(id)) throw new Error("Benchmark is already running");
  return mutateBenchmark(id, (r) => {
    if (!r.execution || !["complete", "failed"].includes(r.execution.status))
      throw new Error("Benchmark is already running");
    if (r.humanReviews.length)
      throw new Error("Reviewed outputs are locked; start a new benchmark");
    if (r.variants.every((v) => v.status === "ready"))
      throw new Error("All variants are already complete");
    r.execution.input.models.forEach(assertModelAvailable);
    r.execution.status = "queued";
    r.execution.workerId = benchmarkWorkerId;
    r.execution.error = null;
  });
}
