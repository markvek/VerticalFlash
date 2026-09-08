import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";

// This adapter deliberately connects only to the existing local application.
const origin = new URL(process.env.VERTICALFLASH_URL || "http://localhost:3000");
if (!["http:", "https:"].includes(origin.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("VERTICALFLASH_URL must be a loopback HTTP(S) origin, such as http://localhost:3000");
}
const base = origin.origin;
const server = new McpServer({ name: "verticalflash", version: "0.1.0" });
const videoId = z.string().regex(/^[\w-]+$/).describe("videoId returned by VerticalFlash, without .mp4");
const filename = z.string().min(1).regex(/^[^/\\]+$/).refine((value) => value !== "." && value !== "..");
const index = z.number().int().nonnegative();
const seconds = z.number().finite().nonnegative();

async function api(path, method = "GET", body) {
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(660_000),
      redirect: "error",
    });
  } catch {
    throw new Error(`Could not reach VerticalFlash at ${base}. Ensure the app is running. If a write was interrupted, check the project before retrying; work may have completed.`);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data?.error || "VerticalFlash request failed"}`);
  if (data === null) throw new Error("VerticalFlash returned a non-JSON response. Check VERTICALFLASH_URL.");
  return data;
}

function tool(name, description, inputSchema, readOnly, action) {
  server.registerTool(name, {
    description,
    inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly },
  }, async (args, extra) => {
    // Some clients reset their tool timeout on progress. Other clients need a
    // longer timeout configured explicitly; the app's non-master jobs are synchronous.
    let progress = 0;
    const token = extra._meta?.progressToken;
    const timer = token === undefined ? null : setInterval(() => {
      extra.sendNotification({ method: "notifications/progress", params: {
        progressToken: token, progress: ++progress, message: "VerticalFlash is processing this step",
      } }).catch(() => {});
    }, 15_000);
    try {
      const result = { base_url: base, data: await action(args) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Operation failed" }] };
    } finally {
      if (timer) clearInterval(timer);
    }
  });
}

tool("project_list", "List local storyboard sources and editing projects. Use their returned IDs and filenames.", {}, true,
  () => api("/api/downloads"));
tool("library_list", "List available local clips and their saved analysis. Upload and analyze missing footage in the app's Clip library.", {}, true,
  () => api("/api/library"));

const resourcePaths = {
  analysis: (id) => `/api/analyze/${id}`,
  transcript: (id) => `/api/master/${id}/segments`,
  storyboards: (id) => `/api/master/${id}/storyboards`,
  master_status: (id) => `/api/master/${id}/status`,
  broll: (id) => `/api/analyze/${id}/broll`,
  text: (id) => `/api/analyze/${id}/text-overlays`,
  render: (id) => `/api/analyze/${id}/render`,
};
tool("project_read", "Read a saved project artifact. Transcript/storyboards/master_status use the master ID; editing artifacts use the cutdown ID. A 404 means this artifact is not available yet.", {
  video_id: videoId,
  resource: z.enum(["analysis", "transcript", "storyboards", "master_status", "broll", "text", "render"]),
}, true, ({ video_id, resource }) => api(resourcePaths[resource](video_id)));

tool("source_prepare", "Join library clips in order and analyze a storyboard master. Uses configured AI services and may incur cost. Returns a background job; poll project_read master_status until ready or failed. Do not automatically repeat this call.", {
  clips: z.array(filename).min(1).max(20), title: z.string().min(1).max(100),
  timing_engine: z.enum(["whisperx", "gemini"]).optional(),
}, false, (args) => api("/api/master", "POST", { ...args, background: true }));

tool("storyboard_propose", "Generate additional storyboard options from a ready master's transcript. Existing options are preserved. Uses Gemini; brief is at most 500 characters.", {
  video_id: videoId, count: z.number().int().min(1).max(5),
  lengths: z.array(z.number().min(5).max(180)).min(1).max(5),
  pacing: z.enum(["fast", "standard", "detailed"]), allow_broll: z.boolean(), brief: z.string().max(500),
}, false, ({ video_id, ...body }) => api(`/api/master/${video_id}/storyboards`, "POST", body));

const beat = z.object({
  source: z.object({ filename, offset: seconds }).optional(), thumbnail: z.string().optional(),
  fix_note: z.string().max(2000).optional(), section: z.enum(["hook", "main", "end"]),
  start: seconds, end: seconds, start_word: index.nullable(), end_word: index.nullable(),
  text: z.string(), on_screen_text: z.string(), show: z.enum(["source", "broll"]),
  broll_hint: z.object({ description: z.string(), tags: z.array(z.string()) }).nullable(),
}).refine((value) => value.end > value.start, "Beat end must follow start");
tool("storyboard_update", "Save the complete ordered beat list of one storyboard. Read it immediately before editing and preserve unchanged fields. The app saves a revision, but does not reject concurrent stale writes.", {
  video_id: videoId, storyboard_id: z.string().min(1), beats: z.array(beat).min(1),
}, false, ({ video_id, ...body }) => api(`/api/master/${video_id}/storyboards`, "PATCH", body));
tool("edit_create", "Cut the selected storyboard into a new editing project. Use after the user's storyboard choice or within their delegated brief. Each completed call creates another edit; inspect project_list after a timeout before retrying.", {
  video_id: videoId, storyboard_id: z.string().min(1),
}, false, ({ video_id, ...body }) => api(`/api/master/${video_id}/storyboards/accept`, "POST", body));

tool("shot_trim", "Change one cutdown shot's source range in seconds. Read the cutdown analysis first. Only for accepted storyboard edits; keep cuts on word boundaries when timings exist.", {
  video_id: videoId, shot_index: index, source_start: seconds, source_end: seconds,
}, false, ({ video_id, shot_index, source_start, source_end }) => {
  if (source_end <= source_start) throw new Error("source_end must follow source_start");
  return api(`/api/analyze/${video_id}`, "PATCH", { shots: [{ index: shot_index, source_start, source_end }] });
});
tool("broll_suggest", "Use Gemini to suggest and match B-roll over spoken phrases. Requires analyzed library clips. Suggestions are saved but are not rendered until placed.", {
  video_id: videoId,
}, false, ({ video_id }) => api(`/api/analyze/${video_id}/broll`, "POST", { action: "suggest" }));
tool("broll_place", "Place a saved B-roll suggestion using one of its candidate filenames. Fetches the current track before saving. Coordinate edits with the user; the app has no cross-client revision checks.", {
  video_id: videoId, segment_id: z.string().min(1), filename,
  clip_start: seconds.optional(),
}, false, async ({ video_id, segment_id, filename: selected, clip_start }) => {
  const { track } = await api(`/api/analyze/${video_id}/broll`);
  const segment = track.segments.find((entry) => entry.id === segment_id);
  if (!segment) throw new Error("Unknown B-roll segment. Read the current B-roll track.");
  const candidate = segment.candidates.find((entry) => entry.filename === selected);
  if (!candidate) throw new Error("Choose a filename from this segment's candidates.");
  segment.clip = { filename: selected, clip_start: clip_start ?? candidate.clip_start, source: "library" };
  segment.status = "placed";
  return api(`/api/analyze/${video_id}/broll`, "PUT", { segments: track.segments });
});
tool("broll_remove", "Remove one B-roll segment, leaving other segments intact. The speaker's source footage will show in its place.", {
  video_id: videoId, segment_id: z.string().min(1),
}, false, async ({ video_id, segment_id }) => {
  const { track } = await api(`/api/analyze/${video_id}/broll`);
  if (!track.segments.some((entry) => entry.id === segment_id)) throw new Error("Unknown B-roll segment.");
  return api(`/api/analyze/${video_id}/broll`, "PUT", { segments: track.segments.filter((entry) => entry.id !== segment_id) });
});
tool("text_update", "Set or hide on-screen text for one shot. This changes a text overlay, not the spoken transcript.", {
  video_id: videoId, shot_index: index, text: z.string().max(500), include: z.boolean(),
}, false, ({ video_id, ...body }) => api(`/api/analyze/${video_id}/text-overlays`, "PATCH", body));
tool("render_video", "Render the current edit and return its manifest. Specify audio and text explicitly. Original preserves speech beneath B-roll; music replaces the soundtrack. May take several minutes and may use Gemini for saved fix notes. No automatic retry.", {
  video_id: videoId, audio: z.enum(["original", "music", "none"]),
  music_filename: filename.optional(), burn_text: z.boolean(),
}, false, ({ video_id, ...body }) => {
  if (body.audio === "music" && !body.music_filename) throw new Error("music_filename is required when audio is music.");
  return api(`/api/analyze/${video_id}/render`, "POST", body);
});

const guides = {
  workflow: "SKILL.md",
  brief: "references/creative-brief.md",
  storyboard: "references/storyboarding.md",
  editing: "references/editing-broll.md",
};
tool("workflow_guide", "Read VerticalFlash-specific guidance for the current creative stage.", {
  stage: z.enum(["workflow", "brief", "storyboard", "editing"]),
}, true, ({ stage }) => readFile(new URL(`../verticalflash-video/${guides[stage]}`, import.meta.url), "utf8"));

await server.connect(new StdioServerTransport());
