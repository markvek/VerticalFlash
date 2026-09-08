import assert from "node:assert/strict";
import { test } from "node:test";
import {
  modelGenerator,
  checkedModelOptions,
} from "../src/lib/models/providers";
import {
  getGeminiClient,
  getGeminiModel,
  GEMINI_MODEL,
} from "../src/lib/gemini";
import { StoryboardBenchmarkInputZ } from "../src/lib/storyboard-benchmark-schema";

test("provider adapters send the selected model and common image evidence without fallback", async () => {
  const oldFetch = globalThis.fetch;
  for (const key of [
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
  ])
    process.env[key] = "fixture-secret";
  process.env.BENCHMARK_GEMINI_MODELS = "fixture-gemini";
  process.env.BENCHMARK_OPENAI_MODELS = "fixture-openai";
  process.env.BENCHMARK_CLAUDE_MODELS = "fixture-claude";
  process.env.BENCHMARK_GROK_MODELS = "fixture-grok";
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    const body = JSON.parse(String(init?.body || "{}"));
    calls.push({ url: address, body });
    const data = address.includes("googleapis")
      ? {
          modelVersion: body.model ?? "fixture-gemini",
          candidates: [
            {
              content: { role: "model", parts: [{ text: '{"ok":true}' }] },
              finishReason: "STOP",
            },
          ],
        }
      : address.includes("anthropic")
        ? {
            model: body.model,
            content: [{ type: "text", text: '{"ok":true}' }],
          }
        : address.includes("openai")
          ? {
              status: "completed",
              model: body.model,
              output: [
                { content: [{ type: "output_text", text: '{"ok":true}' }] },
              ],
            }
          : {
              model: body.model,
              choices: [{ message: { content: '{"ok":true}' } }],
            };
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    for (const provider of ["gemini", "openai", "claude", "grok"] as const) {
      const response = await modelGenerator({
        provider,
        model: `fixture-${provider}`,
      })({
        prompt: "Compare footage",
        schema: { type: "object" },
        images: [{ label: "clip.mp4 at 1s", data: "aW1hZ2U=" }],
      });
      assert.deepEqual(JSON.parse(response.text), { ok: true });
      const call = calls.at(-1)!;
      assert.ok(JSON.stringify(call.body).includes("aW1hZ2U="));
      assert.ok(JSON.stringify(call.body).includes("clip.mp4 at 1s"));
      assert.ok(
        call.url.includes(`fixture-${provider}`) ||
          call.body.model === `fixture-${provider}`,
      );
    }
    const ai = getGeminiClient("fixture-gemini");
    assert.equal(getGeminiModel(ai), "fixture-gemini");
    await ai.models.generateContent({ model: GEMINI_MODEL, contents: "test" });
    assert.ok(calls.at(-1)!.url.includes("fixture-gemini"));
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    await assert.rejects(
      () =>
        modelGenerator({ provider: "openai", model: "fixture-openai" })({
          prompt: "test",
          schema: {},
        }),
      /HTTP 401/,
    );
    const options = await checkedModelOptions();
    assert.ok(options.every((o) => !o.available));
    assert.ok(!JSON.stringify(options).includes("fixture-secret"));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("benchmark input enforces four distinct models and separate footage roles", () => {
  const valid = {
    requestId: "aabbccdd-1234-4123-8123-123456789abc",
    title: "test",
    clips: ["core.mp4"],
    timingEngine: null,
    request: {
      count: 1,
      lengths: [22],
      pacing: "standard",
      allow_broll: false,
      brief: "",
    },
    brollClips: [],
    models: ["a", "b", "c", "d"].map((model) => ({
      provider: "gemini",
      model,
    })),
  };
  assert.ok(StoryboardBenchmarkInputZ.safeParse(valid).success);
  assert.ok(
    !StoryboardBenchmarkInputZ.safeParse({
      ...valid,
      models: [
        valid.models[0],
        valid.models[0],
        valid.models[2],
        valid.models[3],
      ],
    }).success,
  );
  assert.ok(
    !StoryboardBenchmarkInputZ.safeParse({
      ...valid,
      request: { ...valid.request, allow_broll: true },
      brollClips: ["core.mp4"],
    }).success,
  );
  assert.ok(
    !StoryboardBenchmarkInputZ.safeParse({ ...valid, clips: ["../core.mp4"] })
      .success,
  );
});

test("provider comparison never fills missing providers with extra Gemini models", async () => {
  const { defaultBenchmarkModelIds, modelId } =
    await import("../src/lib/models/schema");
  const options = [
    { provider: "gemini" as const, model: "a", available: true },
    { provider: "gemini" as const, model: "b", available: true },
    { provider: "gemini" as const, model: "c", available: true },
    { provider: "gemini" as const, model: "d", available: true },
    { provider: "openai" as const, model: "a", available: false },
  ].map((option) => ({
    ...option,
    id: modelId(option),
    label: option.model,
    reason: null,
  }));
  assert.deepEqual(defaultBenchmarkModelIds(options), ["gemini:a"]);
  assert.equal(defaultBenchmarkModelIds(options, false).length, 4);
  const input = {
    requestId: "aabbccdd-1234-4123-8123-123456789abc",
    comparisonMode: "providers",
    title: "test",
    clips: ["core.mp4"],
    timingEngine: null,
    request: {
      count: 1,
      lengths: [22],
      pacing: "standard",
      allow_broll: false,
      brief: "",
    },
    brollClips: [],
    models: options.slice(0, 4),
  };
  assert.equal(StoryboardBenchmarkInputZ.safeParse(input).success, false);
  assert.equal(
    StoryboardBenchmarkInputZ.safeParse({
      ...input,
      models: ["gemini", "openai", "claude", "grok"].map((provider) => ({
        provider,
        model: "fixture",
      })),
    }).success,
    true,
  );
});
