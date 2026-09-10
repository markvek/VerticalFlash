import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import {
  BENCHMARK_PROVIDERS,
  BENCHMARK_STAGES,
  BenchmarkAiReviewZ,
  BenchmarkHumanReviewZ,
  BenchmarkProviderZ,
  BenchmarkRunZ,
  BenchmarkSourceZ,
  BenchmarkStageZ,
  type BenchmarkProvider,
  type BenchmarkRun,
  type BenchmarkSource,
  type BenchmarkStage,
} from "./benchmark-schema";
import { BENCHMARKS_DIR } from "./paths";

const BLIND_LABELS = ["Variant A", "Variant B", "Variant C", "Variant D"];

export interface CreateBenchmarkInput {
  title?: string;
  source: BenchmarkSource;
  providers?: BenchmarkProvider[];
  stages?: BenchmarkStage[];
}

function assertRunId(id: string): void {
  if (!/^[\w-]+$/.test(id)) {
    throw new Error("Invalid benchmark id");
  }
}

function runPath(id: string): string {
  assertRunId(id);
  return join(BENCHMARKS_DIR, `${id}.json`);
}

export async function writeRun(run: BenchmarkRun): Promise<BenchmarkRun> {
  await fs.mkdir(BENCHMARKS_DIR, { recursive: true });
  const parsed = BenchmarkRunZ.parse(run);
  const path = runPath(parsed.id);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(parsed, null, 2));
  await fs.rename(temporary, path);
  return parsed;
}

function normalizeProviders(input: unknown): BenchmarkProvider[] {
  const requested = Array.isArray(input) ? input : BENCHMARK_PROVIDERS;
  const seen = new Set<BenchmarkProvider>();
  for (const provider of requested) {
    const parsed = BenchmarkProviderZ.parse(provider);
    seen.add(parsed);
  }
  return Array.from(seen);
}

function normalizeStages(input: unknown): BenchmarkStage[] {
  const requested = Array.isArray(input) ? input : BENCHMARK_STAGES;
  const seen = new Set<BenchmarkStage>();
  for (const stage of requested) {
    const parsed = BenchmarkStageZ.parse(stage);
    seen.add(parsed);
  }
  return Array.from(seen);
}

function statusFor(run: BenchmarkRun): BenchmarkRun["status"] {
  if (run.humanReviews.length > 0) return "reviewed";
  return run.variants.some((variant) => variant.status === "ready") ? "ready" : "draft";
}

function blindProviderOrder(providers: BenchmarkProvider[]): BenchmarkProvider[] {
  return providers
    .map((provider) => ({ provider, key: randomUUID() }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => entry.provider);
}

export async function listBenchmarkRuns(): Promise<BenchmarkRun[]> {
  await fs.mkdir(BENCHMARKS_DIR, { recursive: true });
  const files = await fs.readdir(BENCHMARKS_DIR).catch(() => [] as string[]);
  const runs = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          return BenchmarkRunZ.parse(JSON.parse(await fs.readFile(join(BENCHMARKS_DIR, file), "utf8")));
        } catch {
          return null;
        }
      })
  );
  return runs
    .filter((run): run is BenchmarkRun => run !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function readBenchmarkRun(id: string): Promise<BenchmarkRun | null> {
  try {
    return BenchmarkRunZ.parse(JSON.parse(await fs.readFile(runPath(id), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function createBenchmarkRun(input: CreateBenchmarkInput): Promise<BenchmarkRun> {
  const source = BenchmarkSourceZ.parse(input.source);
  const providers = normalizeProviders(input.providers);
  const stages = normalizeStages(input.stages);
  if (providers.length === 0) throw new Error("Select at least one provider");
  if (stages.length === 0) throw new Error("Select at least one benchmark stage");

  const now = new Date().toISOString();
  const variants = blindProviderOrder(providers).map((provider, index) => ({
    id: `${provider}-${randomUUID().slice(0, 8)}`,
    provider,
    blindLabel: BLIND_LABELS[index] ?? `Variant ${index + 1}`,
    status: "waiting" as const,
    model: null,
    output: null,
    technicalScore: null,
    aiJudgeScore: null,
    humanScore: null,
    error: null,
  }));
  const run: BenchmarkRun = {
    id: randomUUID(),
    title: input.title?.trim() || `${source.displayName} benchmark`,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source,
    stages,
    providers,
    fairness: {
      inputLockedAt: now,
      blindLabelsLocked: true,
      sameRendererRequired: true,
      samePromptContractRequired: true,
    },
    variants,
    humanReviews: [],
    aiReviews: [],
  };
  return writeRun(run);
}

export async function assignBenchmarkVariantOutput(
  id: string,
  variantId: string,
  output: BenchmarkRun["variants"][number]["output"]
): Promise<BenchmarkRun> {
  const run = await readBenchmarkRun(id);
  if (!run) throw new Error("Benchmark not found");
  const variant = run.variants.find((entry) => entry.id === variantId);
  if (!variant) throw new Error("Variant not found");
  if (run.execution || run.humanReviews.length) throw new Error("Benchmark outputs are locked");
  variant.output = output;
  variant.status = output ? "ready" : "waiting";
  variant.error = null;
  const now = new Date().toISOString();
  run.updatedAt = now;
  run.status = statusFor(run);
  return writeRun(run);
}

async function addBenchmarkHumanReviewUnlocked(
  id: string,
  review: unknown
): Promise<BenchmarkRun> {
  const run = await readBenchmarkRun(id);
  if (!run) throw new Error("Benchmark not found");
  const parsed = BenchmarkHumanReviewZ.parse(review);
  const knownVariants = new Set(run.variants.map((variant) => variant.id));
  const readyVariants = new Map(
    run.variants
      .filter((variant) => variant.status === "ready")
      .map((variant) => [variant.id, variant])
  );
  if (readyVariants.size === 0) {
    throw new Error("Assign at least one provider output before reviewing");
  }
  if (parsed.winnerVariantId && !readyVariants.has(parsed.winnerVariantId)) {
    throw new Error("Winner must be one of this benchmark's variants");
  }
  for (const entry of parsed.reviews) {
    if (!knownVariants.has(entry.variantId)) {
      throw new Error("Review contains an unknown variant");
    }
    if (!readyVariants.has(entry.variantId)) {
      throw new Error("Only ready variants can be reviewed");
    }
  }
  const reviewedIds = new Set(parsed.reviews.map((entry) => entry.variantId));
  if (reviewedIds.size !== parsed.reviews.length) throw new Error("Review each variant once");
  if (run.execution && run.execution.status !== "complete") throw new Error("Wait until the benchmark completes before reviewing");
  const readyIds = Array.from(readyVariants.keys());
  for (const readyId of readyIds) {
    if (!reviewedIds.has(readyId)) {
      throw new Error("Review every ready variant before submitting");
    }
  }

  run.humanReviews.push(parsed);
  for (const entry of parsed.reviews) {
    const variant = run.variants.find((candidate) => candidate.id === entry.variantId);
    if (!variant) continue;
    const scores = Object.entries(entry.scores).filter(([key]) => key !== "broll_fit" || !run.execution || run.execution.input.request.allow_broll).map(([, value]) => value);
    const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    variant.humanScore = Math.min(100, Math.round((average * 10 + (entry.wouldPost ? 5 : 0)) * 10) / 10);
  }
  run.updatedAt = new Date().toISOString();
  run.status = "reviewed";
  return writeRun(run);
}

const shared = globalThis as typeof globalThis & { benchmarkLocks?: Map<string, Promise<unknown>> };
const locks = shared.benchmarkLocks ??= new Map<string, Promise<unknown>>();
export async function withBenchmarkLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const pending = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
  locks.set(id, pending);
  try { return await pending; } finally { if (locks.get(id) === pending) locks.delete(id); }
}
export async function mutateBenchmark(id: string, update: (run: BenchmarkRun) => void) {
  return withBenchmarkLock(id, async () => {
    const run = await readBenchmarkRun(id);
    if (!run) throw new Error("Benchmark not found");
    update(run);
    run.updatedAt = new Date().toISOString();
    run.status = statusFor(run);
    return writeRun(run);
  });
}
export async function addBenchmarkHumanReview(id: string, review: unknown) {
  return withBenchmarkLock(id, () => addBenchmarkHumanReviewUnlocked(id, review));
}

// Stores the AI judge's verdict (latest wins) and mirrors each variant's
// predicted virality into its aiJudgeScore. Advisory: leaves humanScore alone.
export async function setBenchmarkAiReview(
  id: string,
  review: unknown,
): Promise<BenchmarkRun> {
  return withBenchmarkLock(id, async () => {
    const run = await readBenchmarkRun(id);
    if (!run) throw new Error("Benchmark not found");
    const parsed = BenchmarkAiReviewZ.parse(review);
    const known = new Set(run.variants.map((variant) => variant.id));
    for (const entry of parsed.reviews) {
      if (!known.has(entry.variantId)) {
        throw new Error("AI review contains an unknown variant");
      }
    }
    run.aiReviews = [parsed];
    for (const entry of parsed.reviews) {
      const variant = run.variants.find((v) => v.id === entry.variantId);
      if (variant) variant.aiJudgeScore = entry.virality;
    }
    run.updatedAt = new Date().toISOString();
    run.status = statusFor(run);
    return writeRun(run);
  });
}
