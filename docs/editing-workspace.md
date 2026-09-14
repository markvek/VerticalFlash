# Editing workspace

Footage selection, storyboard exploration, virality review, and detailed editing share the existing preview / editing panel / timeline layout.

## Remake a scanned video

1. Choose **Download & edit** on a TikHub result. Already saved results offer **Open editor**. **Download file** remains available separately.
2. Editing opens immediately and shows download, segment analysis, tagging, and library matching progress. Preparation runs on the server, survives leaving the scan page, reuses completed stages, and offers a retry after interruption.
3. The reference supplies the segment structure. The main Video track shows each active replacement with **Suggested**, **Selected**, **Original**, or **Needs replacement** status. Library matching prefers complete, non-weak matches with saved trim ranges and avoids repetition where possible.
4. In **Replace shot**, select a timeline segment to see up to four alternatives. **Preview** uses the left player without saving. **Use clip** commits the replacement, clears the original-footage override, and keeps the segment timing and existing audio setting. **Reference / My edit** switches comparison views.
5. Use **All clips**, **Upload Footage**, or the expandable **Generate alternative with Gemini Omni** controls when needed. Drag library footage onto a timeline Replace target. Generated clips require explicit acceptance; generation itself leaves the active draft unchanged.
6. Resolve missing matches with another clip or **Keep original** before export. Missing or too-short saved choices show reference footage and block export until resolved; they never silently choose another library clip. Explicitly choosing the same clip for multiple segments is supported.
7. **Undo replacement / Redo replacement** persist across reloads and do not overwrite intervening timeline edits. **Create another edit** forks the draft and accepted generated media independently.

This entry does not require storyboard adoption. The uploaded-footage → Storyboards flow below is unchanged. Reference TikTok statistics are not treated as performance of the user's edit, and saved storyboard virality reviews do not assess replacement edits.

Preparation uses `/api/reference-import/<tiktok-id>` and a `reference-import` sidecar. Recommendations carry `mode: "reference"`, explicit active choices, provenance, and unresolved state. Replacement history is separate from timeline structure history; both are excluded when forking. The source video is retained unchanged.

## User flow

1. Open **Editing → New editing project** and upload videos or select existing library clips. Search descriptions and tags, or filter by category and date. Uploaded and existing clips share the ordered selection tray.
2. Choose **Continue to Storyboards**. Footage preparation runs in the background; the workspace shows progress and offers a retry after processing failures.
3. Explore ideas in **Storyboards**, including beat editing, source previews, transcript segments, generation controls, and virality reviews. The editing timeline stays empty until an idea is adopted.
4. Choose **Use storyboard & edit** to save that revision and open its cutdown in **Video Editing**, with its shots on the timeline. The adopted idea receives a green outline and an **In this edit** label.
5. Return to **Storyboards** to explore other ideas. Browsing does not change the active timeline. **Create new edit from this idea** creates an independent cutdown; **Open existing edit** and the edit picker resume previous work. **Duplicate current edit** copies manual changes and works before an export exists.
6. Use **Upload Footage** to upload or select additional library footage. Choose a source range and insert, replace, or add B-roll with buttons, or drag a footage card to the corresponding timeline target. Uploads must finish before they become playable timeline footage.
7. Export through the **Export** tab and continue using the existing caption, download, and publishing controls.

## Selection and review behavior

- The URL identifies the source project, active edit, browsed idea, and panel. Browser storage remembers the last selection when a link does not explicitly specify one.
- Changing active edits finishes pending framing, text, instruction, generation-prompt, and storyboard saves. A failed save leaves the current edit open.
- Storyboard adoption submits an idempotency key: retrying a completed request returns the same child, while an explicit new creation uses a new key.
- An edit retains its adopted storyboard snapshot. Updating an idea does not rewrite existing edits.
- Virality Review can show either the browsed idea or the adopted snapshot. Timeline changes are labeled separately; the saved review does not assess subsequent framing, audio, text, or rendered output.
- Storyboard previews use source time; detailed editing uses the active cutdown's timeline.

## Routes and stored data

The canonical project route is `/editing/<master-filename>?view=storyboards`; an active edit adds `edit=<child-id>&view=video`. Optional `idea=<storyboard-id>` preserves the browsed idea.

| Existing route | Destination |
| --- | --- |
| `/storyboard` | `/editing/new` |
| `/storyboards` | `/editing` |
| `/storyboards/<master-filename>` | Parent Editing workspace, Storyboards tab |
| `/editing/<child-filename>` | Parent Editing workspace with that exact child selected |
| `/downloads/<filename>` | Compatible Editing workspace |

The Editing list groups children under their source project. Standalone prompt, music, and downloaded-video editors remain available. Media, original master offsets, legacy storyboard documents, and child snapshots retain their existing storage locations.

Inserted and replaced main-track footage uses an explicit library source reference with local timestamps. The timeline API validates its range and project inclusion, remaps indexed settings and B-roll anchors, updates shot and beat metadata together, and includes the operation in undo/redo and export invalidation. B-roll additions preserve main-track narration.

## Validation

Run `node --import tsx --test scripts/*.test.ts`, `npm run typecheck`, `npm run lint`, and `npm run build`. Timeline integration tests use temporary data directories and actual FFmpeg sources/exports. Regression coverage includes repeated storyboard acceptance, duplication before export, insertion/replacement/B-roll, undo/redo, independent child metadata, route grouping, and failed nested saves.

Browser verification covers an empty timeline before adoption, acceptance-to-edit transition, duplicate clicks, the adopted outline, browsing without changing edits, refresh and Back navigation, distinct drop actions, failed-save isolation, and desktop/mobile layouts.
