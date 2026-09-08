# Editing and B-roll

Use the accepted cutdown ID for editing tools. Start by reading `analysis`, `broll`, and `text` with `project_read`; use the master ID only to retrieve its transcript or storyboard.

## Trim and text

`shot_trim` changes one cutdown shot's `source_start` and `source_end` in source seconds, using its current `shot_index`. Keep bounds within available footage and align with speech where reliable word timings exist. Re-read analysis after a trim because downstream timing changes. Reorder story beats through `storyboard_update` before accepting a new edit; there is no general cutdown reorder tool in this kit.

`text_update` takes `shot_index`, `text`, and `include`. This controls the shot's on-screen overlay, not the transcript or a new voiceover. Preserve the user's wording and avoid treating unsupported visual effects as completed edits.

## Find and place B-roll

`broll_suggest` finds coverage moments and matches analyzed library footage using Gemini. Read each suggestion's phrase, description, candidates, confidence, and moment notes. Show candidates or link their previews before asking for a choice where the user wants review. Resolve relative media links against `base_url`; a library clip can be opened at `/api/library/clips/<URL-encoded filename>`.

Call `broll_place` with the segment ID and an exact candidate filename. Optionally set `clip_start` in clip seconds. Suggested segments do not render until placed. The connector preserves voice/offset anchors and fetches the latest track before saving, but concurrent browser changes can still conflict.

Use `broll_remove` to return that interval to source footage. If nothing fits, report the missing coverage and let the user retain the speaker or add/analyze footage in the Clip library. Do not claim generated B-roll is available through this connector.

## Preview and finish

Call `render_video` with explicit `audio` and `burn_text`. Use `audio: "original"` to keep the speaker audible under B-roll. `audio: "music"` requires an existing `music_filename` and replaces the soundtrack; it does not mix music under speech. Use `none` only when silence is intended.

Rendering is synchronous and can take several minutes. Saved fix notes can trigger Gemini interpretation. Inspect returned warnings and the actual video: speech continuity, B-roll timing, black gaps, text readability, framing, and duration. Resolve the manifest's media URLs against `base_url`. Report unverified quality if your client cannot play or inspect the video.

After a timeout, read the `render` artifact and check its timestamp/content before repeating work. A prior render is not proof the newest attempt succeeded. Save the resulting edit ID and render link in the conversation so the user can resume. Publishing remains in the app and is outside this connector's tool set.
