import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("downloadable connector works through MCP without paid services", async (t) => {
  const requests = [];
  const anchor = { kind: "words", shot_index: 0, start_word: 4, end_word: 9 };
  const untouched = { id: "keep", status: "placed", clip: { filename: "other.mp4", clip_start: 1, source: "library" } };
  const track = { segments: [
    { id: "cover", anchor, status: "suggested", clip: null, candidates: [{ filename: "demo.mp4", clip_start: 2 }] },
    untouched,
  ] };
  const backend = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/analyze/missing/broll") {
      res.writeHead(404).end(JSON.stringify({ error: "No analysis found for this video" }));
    } else if (req.url?.endsWith("/broll") && req.method === "GET") {
      res.end(JSON.stringify({ track }));
    } else {
      res.end(JSON.stringify(req.method === "GET" ? { files: [{ name: "short-example.mp4" }] } : { saved: body }));
    }
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  const base = `http://127.0.0.1:${backend.address().port}`;
  const client = new Client({ name: "verticalflash-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../server.mjs", import.meta.url))],
    env: { VERTICALFLASH_URL: base }, stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  await t.test("discovers tools and connects to the configured local app", async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "storyboard_update"));
    assert.ok(tools.some((tool) => tool.name === "render_video"));
    assert.ok(!tools.some((tool) => /publish|delete_project/.test(tool.name)));
    const result = await call("project_list");
    assert.equal(result.structuredContent.base_url, base);
    assert.equal(result.structuredContent.data.files[0].name, "short-example.mp4");
  });
  await t.test("loads every workflow guide from the installed kit", async () => {
    for (const stage of ["workflow", "brief", "storyboard", "editing"]) {
      const result = await call("workflow_guide", { stage });
      assert.ok(!result.isError);
      assert.ok(result.structuredContent.data.length > 100);
    }
  });
  await t.test("prepares a background source with the app's existing contract", async () => {
    const result = await call("source_prepare", { clips: ["demo.mp4"], title: "Demo", timing_engine: "whisperx" });
    assert.ok(!result.isError);
    assert.deepEqual(requests.at(-1), { method: "POST", url: "/api/master", body: {
      clips: ["demo.mp4"], title: "Demo", timing_engine: "whisperx", background: true,
    } });
  });
  await t.test("places a candidate without losing voice anchors or other segments", async () => {
    const result = await call("broll_place", { video_id: "short-demo", segment_id: "cover", filename: "demo.mp4" });
    assert.ok(!result.isError);
    const segments = requests.at(-1).body.segments;
    assert.deepEqual(segments[0].anchor, anchor);
    assert.deepEqual(segments[0].clip, { filename: "demo.mp4", clip_start: 2, source: "library" });
    assert.equal(segments[0].status, "placed");
    assert.deepEqual(segments[1], untouched);
  });
  await t.test("rejects invented candidates without a write", async () => {
    const before = requests.filter((entry) => entry.method === "PUT").length;
    const result = await call("broll_place", { video_id: "short-demo", segment_id: "cover", filename: "invented.mp4" });
    assert.equal(result.isError, true);
    assert.equal(requests.filter((entry) => entry.method === "PUT").length, before);
  });
  await t.test("removes only the requested overlay", async () => {
    const result = await call("broll_remove", { video_id: "short-demo", segment_id: "cover" });
    assert.ok(!result.isError);
    assert.deepEqual(requests.at(-1).body.segments, [untouched]);
  });
  await t.test("requires render audio and text choices; preserves original voice", async () => {
    const before = requests.length;
    assert.equal((await call("render_video", { video_id: "short-demo" })).isError, true);
    assert.equal((await call("render_video", { video_id: "short-demo", audio: "music", burn_text: true })).isError, true);
    assert.equal(requests.length, before);
    assert.ok(!(await call("render_video", { video_id: "short-demo", audio: "original", burn_text: true })).isError);
    assert.deepEqual(requests.at(-1).body, { audio: "original", burn_text: true });
  });
  await t.test("invalid IDs and reversed trims never reach the backend", async () => {
    const before = requests.length;
    assert.equal((await call("project_read", { video_id: "../secret", resource: "analysis" })).isError, true);
    assert.equal((await call("shot_trim", { video_id: "short-demo", shot_index: 0, source_start: 3, source_end: 2 })).isError, true);
    assert.equal(requests.length, before);
  });
  await t.test("returns actionable backend errors without retrying", async () => {
    const before = requests.length;
    const result = await call("broll_suggest", { video_id: "missing" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /HTTP 404: No analysis/);
    assert.equal(requests.length, before + 1);
  });
});

test("connector refuses a remote backend", async () => {
  const client = new Client({ name: "connection-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../server.mjs", import.meta.url))],
    env: { VERTICALFLASH_URL: "https://example.com" }, stderr: "pipe",
  });
  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await client.close();
  }
});
