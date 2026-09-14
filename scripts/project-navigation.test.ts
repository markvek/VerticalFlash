import { test } from "node:test";
import assert from "node:assert/strict";
import { projectHref, workspaceProjects } from "../src/lib/project-navigation";
import type { DownloadEntry } from "../src/lib/download-types";
const file = (id: string, project: DownloadEntry["project"], edited = 1): DownloadEntry => ({ videoId: id, name: `${id}.mp4`, project, size: 1, modified: 1, lastEditedAt: edited, displayName: id, version: 1, meta: null, analysis: null, render: null, generatedClips: 0 });
test("old storage stages map into Editing and child links retain their exact edit", () => {
  const master = file("master-one", { kind: "master", title: "Source", sourceClips: [], timingEngine: null });
  const child = file("short-one", { kind: "cutdown", masterId: "master-one", masterFilename: "master-one.mp4", storyboardId: "idea", title: "Edit", hookLine: "", targetDuration: 10, timingSource: "gemini", beats: [] }, 20);
  assert.equal(projectHref({ ...master, stage: "storyboarding" }), "/editing/master-one.mp4?view=storyboards");
  assert.equal(projectHref(child), "/editing/master-one.mp4?edit=short-one&view=video");
  assert.equal(projectHref(file("standalone", null)), "/editing/standalone.mp4");
  assert.deepEqual(workspaceProjects([master, child]).map(f => [f.videoId, f.lastEditedAt]), [["master-one", 20]]);
  assert.deepEqual(workspaceProjects([child]).map(f => f.videoId), ["short-one"], "Missing parents must not hide their edits");
  assert.equal(master.lastEditedAt, 1);
});
