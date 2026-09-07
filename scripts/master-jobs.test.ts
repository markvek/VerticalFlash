import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
let root: string;
let jobs: typeof import("../src/lib/master-jobs");
let paths: typeof import("../src/lib/paths");
before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "verticalflash-master-jobs-"));
  process.env.DATA_DIR = root;
  jobs = await import("../src/lib/master-jobs");
  paths = await import("../src/lib/paths");
  await paths.ensureDataDirs();
});
after(() => fs.rm(root, { recursive: true, force: true }));

test("reserves a persistent storyboard URL without waiting for footage processing", async () => {
  const first = await jobs.createMasterJob({ clips: ["missing.mp4"], title: "First storyboard", timingEngine: "gemini" });
  const second = await jobs.createMasterJob(first.input);
  assert.notEqual(first.videoId, second.videoId);
  assert.equal(first.filename, `${first.videoId}.mp4`);
  assert.equal((await jobs.readMasterJob(first.videoId))?.status, "preparing");
  await assert.rejects(fs.access(join(paths.STORYBOARDS_DIR, first.filename)));
  assert.equal(await jobs.retryMasterJob(first.videoId), null);
  assert.equal(await jobs.readMasterJob("master-missing"), null);
  await assert.rejects(jobs.readMasterJob("../escape"));
});

test("records processing errors and retries the same storyboard URL", async () => {
  const job = await jobs.createMasterJob({ clips: ["missing.mp4"], title: "Retry storyboard", timingEngine: null });
  await jobs.runMasterJob(job.videoId);
  const failed = await jobs.readMasterJob(job.videoId);
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /Clip not found/);
  const retry = await jobs.retryMasterJob(job.videoId);
  assert.equal(retry?.filename, job.filename);
  assert.equal(retry?.status, "preparing");
  assert.equal(retry?.error, null);
});

test("a server restart reports interrupted work instead of polling forever", async () => {
  const job = await jobs.createMasterJob({ clips: ["missing.mp4"], title: "Interrupted storyboard", timingEngine: null });
  const restarted = await exec(process.execPath, ["--import", "tsx", "-e",
    `require('./src/lib/master-jobs').readMasterJob(${JSON.stringify(job.videoId)}).then(job => console.log(JSON.stringify(job)))`,
  ]);
  const status = JSON.parse(restarted.stdout);
  assert.equal(status.filename, job.filename);
  assert.equal(status.status, "failed");
  assert.match(status.error, /server restart/);
});
