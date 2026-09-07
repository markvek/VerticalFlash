import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { join } from "path";
import { promises as fs } from "fs";
import type { TimingSource } from "./project-meta";

// WhisperX is the word-level timing engine for master videos (storyboard
// flow). It is optional: when the binary is missing or the user picks
// "gemini", the master analysis falls back to Gemini's own (approximate)
// timestamps tightened by silence detection. Mirrors ffmpeg.ts: one
// memoized preflight, a readable error, install instructions.

const rawExecFileAsync = promisify(execFile);

export const WHISPERX_INSTALL_HINT =
  "WhisperX is not installed. Install it as a standalone tool: `uv tool install whisperx` " +
  "(or `pipx install whisperx`), or set WHISPERX_BIN in .env.local to the executable. " +
  "Masters can still be analyzed with Gemini timing (approximate).";

export const DEFAULT_WHISPERX_MODEL = "large-v3-turbo";

export class WhisperXMissingError extends Error {
  constructor(detail?: string) {
    super(`${WHISPERX_INSTALL_HINT}${detail ? ` (${detail})` : ""}`);
    this.name = "WhisperXMissingError";
  }
}

export interface WhisperXDetection {
  available: boolean;
  binary: string | null;
  version: string | null;
  reason: string | null;
}

// Candidate executables, in order: the env override, PATH, then the
// default install locations of uv/pipx (which are often not on the
// server's PATH)
function candidates(): string[] {
  const list: string[] = [];
  if (process.env.WHISPERX_BIN) list.push(process.env.WHISPERX_BIN);
  list.push("whisperx");
  list.push(join(homedir(), ".local", "bin", "whisperx"));
  return list;
}

async function probe(binary: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await rawExecFileAsync(binary, ["--version"], {
      timeout: 60_000,
      env: { ...process.env, PYTHONWARNINGS: "ignore" },
    });
    const text = `${stdout}\n${stderr}`;
    const m = text.match(/whisperx\s+v?(\d+\.\d+(?:\.\d+)?)/i) || text.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : "unknown";
  } catch {
    return null;
  }
}

let detected: Promise<WhisperXDetection> | undefined;

// Resolves the first candidate that answers `--version`. Success is
// memoized; a miss is not, so installing WhisperX while the server runs
// takes effect on the next request.
export function detectWhisperX(): Promise<WhisperXDetection> {
  if (!detected) {
    detected = (async () => {
      const tried: string[] = [];
      for (const binary of candidates()) {
        // Absolute paths must exist before we bother spawning them
        if (binary.includes("/")) {
          try {
            await fs.access(binary);
          } catch {
            tried.push(binary);
            continue;
          }
        }
        const version = await probe(binary);
        if (version) return { available: true, binary, version, reason: null };
        tried.push(binary);
      }
      return {
        available: false,
        binary: null,
        version: null,
        reason: `no working whisperx executable (tried ${tried.join(", ")})`,
      };
    })().then((result) => {
      if (!result.available) detected = undefined;
      return result;
    });
  }
  return detected;
}

export function whisperXModel(): string {
  return process.env.WHISPERX_MODEL?.trim() || DEFAULT_WHISPERX_MODEL;
}

// The env default for masters: "whisperx" unless TRANSCRIBER=gemini
export function transcriberDefault(): TimingSource {
  return process.env.TRANSCRIBER?.trim().toLowerCase() === "gemini"
    ? "gemini"
    : "whisperx";
}

export interface TimingEngineChoice {
  engine: TimingSource;
  requested: TimingSource;
  detection: WhisperXDetection;
  // Set when the request could not be honored
  note: string | null;
}

// Decide which engine a master analysis will use: the explicit request
// (UI radio), else the env default; WhisperX degrades to Gemini with a
// note when the binary is missing.
export async function resolveTimingEngine(
  requested?: TimingSource | null
): Promise<TimingEngineChoice> {
  const want = requested ?? transcriberDefault();
  const detection = await detectWhisperX();
  if (want === "whisperx" && !detection.available) {
    return {
      engine: "gemini",
      requested: want,
      detection,
      note: `WhisperX unavailable — ${detection.reason}. Used Gemini timing (approximate).`,
    };
  }
  return { engine: want, requested: want, detection, note: null };
}
