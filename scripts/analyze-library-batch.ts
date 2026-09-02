/**
 * Batch Gemini analysis for the brand clip library.
 *
 * Usage:
 *   npm run analyze:library                     # analyze every un-analyzed clip
 *   npm run analyze:library -- --dry-run        # list what would run, no API calls
 *   npm run analyze:library -- --limit 2        # process at most 2 clips
 *   npm run analyze:library -- --only IMG_0003.MOV
 *
 * Resumable by design: results commit to .metadata.json per clip, and the
 * worklist is "clips with no analysis" — re-running picks up where it left off.
 */
import { promises as fs } from "fs";
import { extname } from "path";
import { analyzeLibraryClip } from "../src/lib/library-analyze";
import { loadLibrary } from "../src/lib/library-store";
import { classifyGeminiError, type GeminiErrorKind } from "../src/lib/gemini";
import { ensureFfmpeg } from "../src/lib/ffmpeg";
import { ensureDataDirs, LIBRARY_DIR } from "../src/lib/paths";
import {
  GEMINI_PRICE_IN_PER_M,
  GEMINI_PRICE_OUT_PER_M,
} from "../src/lib/gemini-pricing";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv"]);
const MIN_GAP_MS = 8_000; // caps generateContent starts at ~7.5/min (free tier is ~10 RPM)
const MAX_ATTEMPTS = 4; // 1 try + 3 retries, transient errors only
const ACTIVE_DEADLINE_MS = 240_000; // headroom for the largest (~79 MB) clip

interface LedgerEntry {
  filename: string;
  kind: GeminiErrorKind;
  message: string;
  attempts: number;
}

class DailyQuotaError extends Error {
  constructor(public original: Error) {
    super(original.message);
  }
}

function parseArgs(argv: string[]) {
  let limit = Infinity;
  let dryRun = false;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--limit") {
      limit = parseInt(argv[++i], 10);
      if (!Number.isFinite(limit) || limit < 1) {
        console.error("--limit requires a positive integer");
        process.exit(1);
      }
    } else if (arg === "--only") {
      only = argv[++i];
      if (!only) {
        console.error("--only requires a filename");
        process.exit(1);
      }
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return { limit, dryRun, only };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredBackoff(retryIndex: number, retryAfterMs?: number): number {
  const base = Math.min(120_000, 15_000 * 2 ** retryIndex);
  const jittered = base * (0.5 + Math.random() * 0.5);
  return retryAfterMs ? Math.max(jittered, retryAfterMs + 1_000) : jittered;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 > 0 ? `${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function tokenCounts(usage?: Record<string, unknown>) {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    input: num(usage?.promptTokenCount),
    output:
      num(usage?.candidatesTokenCount) + num(usage?.thoughtsTokenCount),
  };
}

async function main() {
  const { limit, dryRun, only } = parseArgs(process.argv.slice(2));

  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set (expected in .env.local)");
    process.exit(1);
  }
  try {
    await ensureFfmpeg();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  await ensureDataDirs();

  const library = await loadLibrary();
  const diskFiles = (await fs.readdir(LIBRARY_DIR).catch(() => [])).filter(
    (f) => !f.startsWith(".") && VIDEO_EXTENSIONS.has(extname(f).toLowerCase())
  );
  const inMetadata = new Set(library.videos.map((v) => v.filename));
  const untracked = diskFiles.filter((f) => !inMetadata.has(f));
  if (untracked.length) {
    console.warn(
      `Note: ${untracked.length} video(s) on disk missing from .metadata.json — including them:\n  ${untracked.join("\n  ")}`
    );
  }

  const analyzed = library.videos.filter((v) => v.analysis).length;
  const pendingSet = new Set([
    ...library.videos.filter((v) => !v.analysis).map((v) => v.filename),
    ...untracked,
  ]);
  // Only files that actually exist on disk can be analyzed
  const pending = diskFiles.filter((f) => pendingSet.has(f));

  let worklist = only ? pending.filter((f) => f === only) : pending;
  if (only && worklist.length === 0) {
    const entry = library.videos.find((v) => v.filename === only);
    if (entry?.analysis) {
      // --only means "run this one" even if it was analyzed before
      worklist = diskFiles.filter((f) => f === only);
    }
    if (worklist.length === 0) {
      console.error(`--only: "${only}" not found in ${LIBRARY_DIR}`);
      process.exit(1);
    }
  }
  worklist = worklist.slice(0, limit);

  console.log(
    `Clip library: ${diskFiles.length} videos on disk, ${analyzed} analyzed, ${pending.length} pending.`
  );
  console.log(
    `Processing ${worklist.length} clip(s)${dryRun ? " (dry run)" : ""}.`
  );

  if (dryRun) {
    for (const f of worklist) console.log(`  ${f}`);
    return;
  }

  console.log(
    "Note: avoid clicking 'Analyze with Gemini' in the UI while this runs — concurrent writes to .metadata.json can lose data.\n"
  );

  let stopRequested = false;
  process.on("SIGINT", () => {
    if (stopRequested) {
      console.log("\nSecond interrupt — exiting immediately.");
      process.exit(130);
    }
    stopRequested = true;
    console.log(
      "\nInterrupt received — finishing the current clip, then stopping (Ctrl-C again to force quit)."
    );
  });

  const ledger: LedgerEntry[] = [];
  const clipDurations: number[] = [];
  let succeeded = 0;
  let totalIn = 0;
  let totalOut = 0;
  let quotaHit = false;
  let lastAttemptStart = 0;
  const runStart = Date.now();

  for (let i = 0; i < worklist.length; i++) {
    if (stopRequested || quotaHit) break;
    const filename = worklist[i];
    const clipStart = Date.now();
    const label = `[${String(i + 1).padStart(3)}/${worklist.length}] ${filename}`;

    let attempts = 0;
    try {
      let result;
      // Retry loop: transient errors only; fatal ones surface immediately
      for (;;) {
        const sinceLast = Date.now() - lastAttemptStart;
        if (sinceLast < MIN_GAP_MS) await sleep(MIN_GAP_MS - sinceLast);
        lastAttemptStart = Date.now();
        attempts++;
        try {
          result = await analyzeLibraryClip(filename, {
            activeDeadlineMs: ACTIVE_DEADLINE_MS,
          });
          break;
        } catch (error) {
          const { kind, retryAfterMs } = classifyGeminiError(error);
          const err = error instanceof Error ? error : new Error(String(error));
          if (
            kind === "daily_quota" ||
            (kind === "rate_limit" && (retryAfterMs ?? 0) > 300_000)
          ) {
            throw new DailyQuotaError(err);
          }
          if (
            (kind === "rate_limit" || kind === "unavailable") &&
            attempts < MAX_ATTEMPTS &&
            !stopRequested
          ) {
            const delay = jitteredBackoff(attempts - 1, retryAfterMs);
            console.log(
              `${label}  ${kind} (attempt ${attempts}/${MAX_ATTEMPTS}) — retrying in ${fmtDuration(delay)}`
            );
            await sleep(delay);
            continue;
          }
          throw err;
        }
      }

      succeeded++;
      const clipMs = Date.now() - clipStart;
      clipDurations.push(clipMs);
      if (clipDurations.length > 10) clipDurations.shift();

      const { input, output } = tokenCounts(result.usage);
      totalIn += input;
      totalOut += output;
      const totalCost =
        (totalIn / 1e6) * GEMINI_PRICE_IN_PER_M +
        (totalOut / 1e6) * GEMINI_PRICE_OUT_PER_M;
      const avgMs =
        clipDurations.reduce((a, b) => a + b, 0) / clipDurations.length;
      const remaining = worklist.length - (i + 1);
      console.log(
        `${label}  ok ${fmtDuration(clipMs)}  in ${input.toLocaleString()}/out ${output.toLocaleString()} tok` +
          `  total ~$${totalCost.toFixed(2)} (at paid rates)` +
          `  elapsed ${fmtDuration(Date.now() - runStart)}` +
          (remaining > 0 ? `  ETA ~${fmtDuration(avgMs * remaining)}` : "")
      );
    } catch (error) {
      if (error instanceof DailyQuotaError) {
        quotaHit = true;
        console.log(`${label}  stopped: daily Gemini quota reached`);
        break;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      const { kind } = classifyGeminiError(err);
      ledger.push({ filename, kind, message: err.message, attempts });
      console.log(`${label}  FAILED (${kind}): ${err.message}`);
    }
  }

  const remaining = worklist.length - succeeded - ledger.length;
  console.log(
    `\nDone: ${succeeded} analyzed, ${ledger.length} failed, ${remaining} not attempted.` +
      `  Tokens: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out.`
  );
  if (ledger.length) {
    console.log(
      "Failed (analysis stays unset, so these retry automatically on the next run):"
    );
    for (const e of ledger) {
      console.log(`  ${e.filename}  ${e.kind}  ${e.message}`);
    }
  }
  if (quotaHit) {
    console.log(
      `\nDaily Gemini quota reached after ${succeeded} clip(s). Re-run "npm run analyze:library" tomorrow — remaining clips are picked up automatically.`
    );
  } else if (stopRequested) {
    console.log(
      '\nStopped by interrupt. Re-run "npm run analyze:library" to resume — completed clips are skipped automatically.'
    );
  }
  process.exit(ledger.some((e) => e.kind === "fatal") ? 1 : 0);
}

main().catch((error) => {
  console.error("Batch failed:", error);
  process.exit(1);
});
