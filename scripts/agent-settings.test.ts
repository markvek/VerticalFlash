import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function loadSettingsModule(dataDir: string) {
  process.env.DATA_DIR = dataDir;
  return import("../src/lib/agent-settings");
}

test("agent settings default, persist, and validate choices", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vf-agent-settings-"));
  try {
    const settings = await loadSettingsModule(dataDir);

    assert.deepEqual(
      await settings.readAgentSettings(),
      settings.DEFAULT_AGENT_SETTINGS
    );

    const updated = await settings.updateAgentSettings({
      transcription_timing: "gemini:gemini-3.6-flash",
    });
    assert.equal(updated.transcription_timing, "gemini:gemini-3.6-flash");
    assert.equal(
      (await settings.readAgentSettings()).transcription_timing,
      "gemini:gemini-3.6-flash"
    );

    const future = await settings.updateAgentSettings({
      clip_matching: "openai:gpt-5",
    });
    assert.equal(future.clip_matching, "openai:gpt-5");

    await assert.rejects(
      () => settings.updateAgentSettings({ unknown_step: "whisperx" }),
      /Invalid enum value/
    );
    await assert.rejects(
      () => settings.updateAgentSettings({ video_generation: "whisperx" }),
      /video_generation does not support agent "whisperx"/
    );

    assert.deepEqual(
      await settings.resetAgentSettings(),
      settings.DEFAULT_AGENT_SETTINGS
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
