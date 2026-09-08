# Connect an agent to VerticalFlash

This kit includes a runnable local MCP server and Markdown instructions for creative direction, storyboarding, editing, and B-roll. Version 0.1.0 connects to the existing VerticalFlash APIs. It does not add a hosted service or change your saved projects during installation.

## Install

1. Keep VerticalFlash running on this computer (`npm run dev` in the app folder).
2. Extract the ZIP. In the extracted `verticalflash-agent-kit/mcp` folder, run `npm ci`. Node 20 or newer is required. The app's ffmpeg and configured analysis services are still required for media work.
3. Open `mcp/mcp-config.json`. Replace `/ABSOLUTE/PATH/verticalflash-agent-kit/mcp/server.mjs` with the actual absolute path. Set `VERTICALFLASH_URL` to the app's local origin if you use another port. The default is `http://localhost:3000`.
4. Add that server entry to a client that supports local stdio MCP servers. Merge it with existing server entries. Configuration formats vary by client; the JSON is an example, not a universal installer. Use an absolute path to your Node executable if the client cannot find `node`.
5. Reconnect the client and ask it to call `project_list` and `workflow_guide` with `stage: "workflow"`.

The client starts `server.mjs`; it is normal for `npm start` to wait for MCP input without printing a banner. Keep the extracted folder intact so the connector can load its guides. No API keys belong in this kit: the running application uses its existing configuration. For local HTTPS, configure Node to trust your local certificate authority; do not disable certificate validation.

## Give your agent the workflow

Install the complete `verticalflash-video` folder in your client's skills directory when supported. Otherwise attach `verticalflash-video/SKILL.md` and the relevant Markdown guide to the conversation. The connector also exposes these files through `workflow_guide`, so skill installation is optional.

Try: “Use VerticalFlash to make a 30-second short from my existing footage. Help me choose the angle, show me storyboard options, then edit the selected version and suggest library B-roll. Keep my original voice.”

The [creative brief](verticalflash-video/references/creative-brief.md), [storyboarding guide](verticalflash-video/references/storyboarding.md), and [editing/B-roll guide](verticalflash-video/references/editing-broll.md) describe supported tools and review points.

## Where it runs

The MCP process and VerticalFlash must run on the same computer. The adapter accepts loopback origins only. Grok Bot's cloud computer cannot reach the app on your laptop through `localhost`. A cloud-only MCP client needs a future authenticated remote adapter; this download does not provide one. A locally running agent host can use this connector while calling a cloud model.

## Current behavior

- Upload and analyze library clips in the app. The connector supports creating a source master, generating/revising storyboards, cutting edits, trimming source ranges, placing/removing suggested library B-roll, changing shot text, and rendering.
- Master preparation returns a job; use `project_read` with `resource: "master_status"`. Other media operations may take several minutes. Configure a tool timeout of at least 12 minutes when your client supports it. Progress notifications are sent when the client supplies a progress token.
- Writes use the existing app routes. There is no cross-client stale-write protection or general idempotency yet. Read current state before changing it and coordinate with someone editing in the browser. After an interrupted write, inspect the result before repeating it.
- Original audio, music, and silence are separate render choices. This connector does not mix music under speech. Rendering can interpret existing fix notes through Gemini; inspect resulting warnings and the playable video.
- Paid analysis uses your configured providers. Follow the user's existing budget and review preferences. The connector does not expose publishing, deletion of projects, or AI video generation.
- Resolve returned relative media URLs against the tool result's `base_url`. Open source projects at `/storyboards/<filename>` and accepted edits at `/editing/<filename>`, URL-encoding the filename.

The workflow skill guides decisions; it is not an authorization system. Respect the user's existing instructions and permissions. A successful render response still needs a visual/audio review before describing the video as finished.

The server uses the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) with its local stdio transport.
