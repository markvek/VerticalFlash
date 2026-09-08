import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { NextRequest } from "next/server";
import { GET } from "../src/app/api/settings/agent-kit/[file]/route";
import { AGENT_GUIDES, AGENT_KIT_FILES } from "../src/lib/agent-kit-catalog";

const download = (file: string) => GET(new NextRequest(`http://localhost/api/settings/agent-kit/${encodeURIComponent(file)}`), { params: Promise.resolve({ file }) });

test("ZIP download includes an installable connector and resolvable guide references", async () => {
  const response = await download("verticalflash-agent-kit.zip");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Disposition")!, /^attachment;/);
  assert.equal(response.headers.get("Content-Type"), "application/zip");
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const prefix = "verticalflash-agent-kit/";
  assert.deepEqual(Object.keys(archive).sort(), AGENT_KIT_FILES.map((file) => prefix + file).sort());
  assert.ok(!Object.keys(archive).some((file) => /node_modules|\.env|tiktok-token/.test(file)));
  const pkg = JSON.parse(strFromU8(archive[prefix + "mcp/package.json"]));
  const lock = JSON.parse(strFromU8(archive[prefix + "mcp/package-lock.json"]));
  assert.deepEqual(pkg.dependencies, lock.packages[""].dependencies);
  for (const guide of AGENT_GUIDES) {
    const content = strFromU8(archive[prefix + guide.path]);
    assert.ok(content.length > 100);
    for (const [, reference] of content.matchAll(/\]\((references\/[^)]+)\)/g)) {
      assert.ok(archive[prefix + "verticalflash-video/" + reference], `Missing ${reference}`);
    }
  }
});

test("individual guides and config download as attachments", async () => {
  for (const file of [...AGENT_GUIDES.map((guide) => guide.file), "setup.md", "mcp-config.json"]) {
    const response = await download(file);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Disposition"), `attachment; filename="${file}"`);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.ok((await response.text()).length > 100);
  }
});

test("unknown names, inherited keys, and path traversal are not downloadable", async () => {
  for (const file of ["unknown.md", "../.env.local", "__proto__", "constructor", "mcp/server.mjs", "x\r\ny"]) {
    assert.equal((await download(file)).status, 404);
  }
});
