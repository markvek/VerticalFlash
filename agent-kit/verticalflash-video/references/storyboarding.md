# Storyboarding with source footage

1. Reuse an existing ready master when appropriate. Otherwise call `source_prepare` with exact library filenames in the intended order, a title, and optionally `timing_engine` (`whisperx` or `gemini`). It returns a master ID and background status. Poll `project_read` with that ID and `resource: "master_status"` until ready or failed. Do not regenerate the source to poll it.
2. Read `project_read` with `resource: "transcript"`. Use its timing source, words, and semantic segments to find complete hooks, useful explanations, and endings. Gemini timing can be approximate; describe that limitation when it affects a cut.
3. Call `storyboard_propose`. Supply `count` (1–5), `lengths` (one duration shared by all options or one per option, 5–180 seconds), `pacing` (`fast`, `standard`, `detailed`), `allow_broll`, and a brief of at most 500 characters. Generation uses the app's configured Gemini service.
4. Compare options through their actual hook, angle, beat text, and estimated duration. Link to `/storyboards/<master filename>` on the returned `base_url`. Explain the meaningful differences and follow the user's requested level of review.
5. To change one option, read current `storyboards` first and call `storyboard_update` with its `storyboard_id` and complete ordered `beats` array. Preserve unchanged fields, footage references, and fix notes. For word-timed source beats, update word ranges as well as the intended range; the server resolves speech/timing from those words. Do not invent spoken lines. This saves a storyboard revision.
6. Call `edit_create` after a selection or within the user's delegated brief. Store the returned edit's ID and filename separately from the master. Link to `/editing/<edit filename>`. Repeating this operation creates another editing project.

Existing accepted edits keep their storyboard snapshot. Revising a source storyboard does not automatically update an earlier cutdown. Either edit that cutdown deliberately or create an edit from the newly selected storyboard. If a call times out, inspect `project_list` and the source's saved `storyboards` before accepting again.

B-roll hints describe intended coverage. Actual candidates and placement are handled in editing. Keep unresolved footage visible in the proposal.
