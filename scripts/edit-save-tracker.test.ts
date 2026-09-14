import assert from "node:assert/strict";
import { test } from "node:test";
import { trackEditSave, flushEditSaves } from "../src/lib/edit-save-tracker";

test("switching waits for nested saves and failed fields require their own successful retry", async () => {
  let finish!: () => void;
  const save = trackEditSave("edit-a", () => new Promise<void>(resolve => { finish = resolve; }), "prompt:0");
  let flushed = false;
  const flush = flushEditSaves("edit-a").then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);
  finish(); await save; await flush;
  assert.equal(flushed, true);
  await assert.rejects(trackEditSave("edit-a", async () => { throw new Error("Failed prompt save"); }, "prompt:0"));
  await trackEditSave("edit-a", async () => {}, "prompt:1");
  await assert.rejects(flushEditSaves("edit-a"), /Failed prompt save/);
  await flushEditSaves("edit-b");
  await trackEditSave("edit-a", async () => {}, "prompt:0");
  await flushEditSaves("edit-a");
});
