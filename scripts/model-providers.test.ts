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

test("provider checks explain rejected keys without exposing provider error bodies", async () => {
  const oldFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  const configs = [
    ["gemini", "GEMINI_API_KEY", "BENCHMARK_GEMINI_MODELS"],
    ["openai", "OPENAI_API_KEY", "BENCHMARK_OPENAI_MODELS"],
    ["claude", "ANTHROPIC_API_KEY", "BENCHMARK_CLAUDE_MODELS"],
    ["grok", "XAI_API_KEY", "BENCHMARK_GROK_MODELS"],
  ];
  try {
    for (const [provider, key, models] of configs) {
      process.env[key] = "private-fixture-credential";
      process.env[models] = `diagnostic-${provider}`;
    }
    globalThis.fetch = async (url) => {
      const address = String(url);
      if (address.includes("googleapis"))
        return Response.json({ models: [{ name: "models/diagnostic-gemini" }] });
      if (address.includes("openai"))
        return Response.json({ error: {
          code: "invalid_api_key",
          message: "Incorrect API key provided: private-fixture-credential",
        } }, { status: 401 });
      if (address.includes("anthropic"))
        return Response.json({ error: {
          type: "authentication_error",
          message: "invalid x-api-key: private-fixture-credential",
        } }, { status: 401 });
      return Response.json({ error: "Incorrect API key provided: private-fixture-credential" }, { status: 400 });
    };
    const options = await checkedModelOptions();
    assert.equal(options.find((o) => o.provider === "gemini")?.available, true);
    for (const [provider, key] of configs.slice(1)) {
      const option = options.find((o) => o.provider === provider)!;
      assert.equal(option.available, false);
      assert.match(option.reason!, new RegExp(`Provider rejected ${key}`));
    }
    assert.ok(!JSON.stringify(options).includes("private-fixture-credential"));

    // Unknown/non-JSON errors must remain safe and preserve the status.
    process.env.BENCHMARK_OPENAI_MODELS = "unknown-error-openai";
    globalThis.fetch = async () => new Response("private-fixture-credential", { status: 503 });
    const failed = await checkedModelOptions();
    assert.ok(failed.every((o) => o.reason?.includes("HTTP 503")));
    assert.ok(!JSON.stringify(failed).includes("private-fixture-credential"));
  } finally {
    globalThis.fetch = oldFetch;
    for (const [, key, models] of configs) {
      for (const name of [key, models]) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
      }
    }
  }
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

test("Claude aliases resolve through the provider without enabling unknown models", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  const oldModels = process.env.BENCHMARK_CLAUDE_MODELS;
  process.env.ANTHROPIC_API_KEY = "alias-fixture-secret";
  process.env.BENCHMARK_CLAUDE_MODELS = [
    "claude-opus-4-5", "claude-sonnet-4-5", "claude-opus-4-5-20251101",
    "claude-unknown", "claude-denied", "claude-broken", "claude-offline",
  ].join(",");
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    const address = new URL(String(url));
    if (address.hostname !== "api.anthropic.com") return Response.json({ data: [] });
    calls.push(address.pathname);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "alias-fixture-secret");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    if (address.pathname === "/v1/models")
      return Response.json({ data: [
        { id: "claude-opus-4-5-20251101" },
        { id: "claude-sonnet-4-5-20250929" },
      ] });
    const name = address.pathname.split("/").at(-1);
    if (name === "claude-opus-4-5") return Response.json({ id: "claude-opus-4-5-20251101" });
    if (name === "claude-sonnet-4-5") return Response.json({ id: "claude-sonnet-4-5-20250929" });
    if (name === "claude-denied") return Response.json({ error: "alias-fixture-secret" }, { status: 403 });
    if (name === "claude-broken") return Response.json({});
    if (name === "claude-offline") throw new Error("alias-fixture-secret");
    return Response.json({ error: "alias-fixture-secret" }, { status: 404 });
  };
  try {
    const options = (await checkedModelOptions()).filter((o) => o.provider === "claude");
    assert.deepEqual(options.filter((o) => o.available).map((o) => o.model), [
      "claude-opus-4-5", "claude-sonnet-4-5", "claude-opus-4-5-20251101",
    ]);
    assert.match(options.find((o) => o.model === "claude-unknown")!.reason!, /could not find/);
    assert.match(options.find((o) => o.model === "claude-denied")!.reason!, /HTTP 403/);
    assert.match(options.find((o) => o.model === "claude-broken")!.reason!, /lookup failed/);
    assert.match(options.find((o) => o.model === "claude-offline")!.reason!, /lookup failed/);
    assert.ok(!calls.includes("/v1/models/claude-opus-4-5-20251101"));
    assert.ok(!JSON.stringify(options).includes("alias-fixture-secret"));
    await checkedModelOptions();
    assert.equal(calls.length, 7, "the model list and alias lookups are cached");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldKey;
    if (oldModels === undefined) delete process.env.BENCHMARK_CLAUDE_MODELS;
    else process.env.BENCHMARK_CLAUDE_MODELS = oldModels;
  }
});
