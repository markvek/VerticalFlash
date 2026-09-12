# Video creation review and improvements

The implementation addresses the usability and data issues identified in the review. The proposed guided progression from footage preparation through export was explicitly excluded; the existing navigation structure remains.

| Problem | Resulting behavior |
| --- | --- |
| Alternate suggestions could not be opened from iteration | The editor loads saved variations and supports both current and legacy variation links. |
| Planning ignored corrected library information | Description, tags and whole-clip transcript corrections take precedence; original AI observations remain available for comparison. |
| Metadata could not be cleared | Empty descriptions, tags, source and capture dates are saved deliberately. Unchanged form fields are not reclassified as human corrections. |
| Corrupt catalogs looked empty and could be overwritten | Reads and writes fail visibly. Writes retain a valid backup, recovery preserves damaged bytes, and edits retain metadata for temporarily absent footage. |
| Generate could use an older prompt | The client waits for prompt saving and submits the exact visible prompt. Attempt history records that prompt; concurrent edits survive completion. |
| Exports only detected some timeline changes | Export revisions cover analysis, selections, framing, B-roll, notes, text, model choice, saved export options, and media file fingerprints. Unsaved client edits also block final export actions. |
| Degraded renders appeared ready | Missing footage, invalid placed B-roll, lost text/audio and selected-clip substitutions produce failures or visible issues. Final download and upload require a current, verified export. |
| Search and creation failures were hidden | Failed searches report errors, partial searches show notices, and creation preserves the project while exposing planning failures and a retry action. |
| Model choices and settings were misleading | Matching, captions and storyboards resolve the project model. Selectors show its name. Future workflow preferences are explicitly labeled inactive. Cost estimates are not borrowed from a different model. |
| Published posts were matched against mutable render facts | Uploads snapshot the exact export, duration, timestamp and caption options. Matching uses historical candidates; users can confirm, correct or unlink suggestions. |
| Final MP4 download was hard to find | Render Details includes a Download MP4 button backed by an immutable export version. |
| Storyboard editing depended on dragging | Each beat supports trim, remove and keyboard-accessible reorder buttons, with undo/redo and revision conflict detection. |
| Storyboard preview advanced during pauses or buffering | Beat transitions follow actual media playback. Native pauses retain the sequence, attached footage switches correctly, and another player cancels the sequence. |
| Processing disappeared when leaving a page | Project activity retains running, completed, failed and interrupted attempts. Server restarts are identified; retries remain explicit. |
| Analytics mixed incomparable and stale numbers | Metric sources and observation times are displayed, stale TikHub data is identified, and post-age and video-length filters support more comparable groups. |
| AI scores looked like measured performance | Hook scales are labeled; benchmark scores describe text assessments. Malformed or incomplete judge responses are rejected instead of receiving invented default scores. |
| Reanalysis could attach old edits to new shots | Shots have stable identities. Reanalysis is rejected when timeline edits, indexed sidecars or saved storyboard ideas need to be preserved. |
| No local workflow measurements | Settings and project activity show recorded attempts, failures by action, first recorded action to preview, metadata corrections, accepted storyboards and previews with issues. |
| TikTok processing was reported as delivery | Processing, inbox delivery and publication are distinguished. Saved upload status can be rechecked without uploading again, and pending uploads of the same export are reused. |

Labels now distinguish replacing a shot from adding B-roll, post captions from on-screen text, and source project names from rendered outputs. Product examples use the configured brand.

## Validation

- `npm test`: 82 tests passed. The full script suite runs including actual FFmpeg media tests and regression coverage for recovery, revisions, immutable exports, historical matching, generation concurrency and interrupted jobs.
- Benchmark generation and judging are injected in tests; a request guard rejects accidental external model calls.
- CI installs FFmpeg and runs the complete suite rather than only the previous small subset.
- Browser checks use synthetic footage in a temporary data directory. They exercise storyboard removal, undo, trimming, pause behavior, source switching, rendering, MP4 download, stale-export blocking and settings persistence.
- Type checking and the production build passed. Lint passed with four existing warnings (three image-element warnings and one unused import).

## Practical limits

Live Gemini generation and TikTok upload/delivery require configured service credentials and were not exercised against paid or publishing services. The browser and regression fixtures use synthetic media and controlled responses.

Activity is persistent local history, not a distributed job queue. A server restart interrupts work; it does not automatically repeat paid operations. Measurements begin with this update and do not reconstruct earlier activity. Storyboard undo/redo is session-local; saved edits persist.

Legacy renders require one new render before verified download/upload. Revision checks conservatively include library and music media, so unrelated changes to those collections can request a new render. Immutable export copies use additional disk space; deleting an editing project also removes its archived exports.

Reanalysis intentionally requires a fresh project once existing edits or storyboard ideas would otherwise become ambiguous. Indexed sidecars remain supported for compatibility, with stable shot identities and the existing timeline remapping preserving their associations.

Lifetime views and AI assessments are not causal evidence that an edit improved audience performance. Age and length filters help comparison but do not replace matched observation windows or experiments.
