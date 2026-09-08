---
name: verticalflash-video
description: Create and revise short videos in VerticalFlash using existing footage, storyboard choices, source trims, text overlays, and library B-roll through its MCP connector.
---

# Make a video with VerticalFlash

Use the connected VerticalFlash tools to turn the user's creative direction into reviewable saved artifacts. Start with `project_list` and `library_list` to identify available projects and footage. Keep master IDs, storyboard IDs, and accepted editing IDs distinct.

Ask only for creative decisions not already supplied: purpose, audience, source material, length, tone, and desired review points. Carry the user's chosen direction across stages. Do not force a fixed number of approvals if they have delegated the work.

- For a new concept, read [creative-brief.md](references/creative-brief.md), or call `workflow_guide` with `stage: "brief"`.
- To propose or change a story, read [storyboarding.md](references/storyboarding.md), or request `stage: "storyboard"`.
- To edit, add B-roll, or finish a video, read [editing-broll.md](references/editing-broll.md), or request `stage: "editing"`.

Treat saved app artifacts as the source of truth. Read them immediately before editing, preserve unrelated fields, and show a link to the result. The current connector uses existing APIs without cross-client revision checks: coordinate browser edits rather than claiming stale updates are prevented. After an interrupted mutation, inspect project state before retrying; creating another source or accepting a storyboard again can duplicate work and spend.

Use exact source speech for transcript-based storyboards. Flag approximate timings. A B-roll description is a request for footage, not evidence that a suitable clip exists. Keep missing footage explicit and use real candidate filenames. Upload/analyze missing library footage in the app; this connector has no upload or AI video-generation tool.

Preserve the user's budget and prior authorization. Explain what changed and which creative decision remains. Render with explicit audio/text options and review the playable result, including warnings. Do not claim this connector provides cloud access, publishing, automatic conflict resolution, or resumable jobs for every operation.
