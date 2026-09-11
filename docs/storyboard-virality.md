# Storyboard review and transition to editing

The workflow is: import clips → create storyboards → automatic hook/virality review → choose optional text and B-roll → Start Edit.

New storyboard ideas are saved before their review runs. The Virality Review view is available in both the storyboard workspace and editor navigation. It assesses hook, audience relevance, clarity, payoff, and shareability; it shows up to three improvements and alternative hooks when supported by existing standalone source speech. These are storyboard assessments, not measured engagement or rendered-video reviews.

The transition previously cut and joined storyboard beats, preserved source audio, copied text into default overlays, and left B-roll beats for later matching. Start Edit now exposes two unchecked options:

- **Add recommended on-screen text:** creates editable overlays with the review's text and timing. It does not create speech captions. Leaving it unchecked explicitly disables generated overlay text in the new edit.
- **Add recommended B-roll:** matches reviewed windows against analyzed library clips and places strong, available matches that are long enough. The speaker's original audio continues. Missing or weak matches stay as editable suggestions, with a warning explaining what remains to be done.

Neither choice changes the storyboard's spoken words or clip order. The resulting editing project contains an immutable copy of its originating storyboard and review. Later editor changes do not silently update that review; the editor labels it as the assessment saved at transition.

Reviews are cached by storyboard content, revision, brief, and rubric version. Saving an edited storyboard invalidates its prior review for handoff. The user can review that revision again, or create an edit with both additions off. Review failures leave generated ideas available and show a retry action.

The rubric is `agent-kit/verticalflash-video/references/virality-review.md`. Reviews use the configured Gemini integration. There are no new third-party dependencies. Forking, variations, TikHub reference searches, and rendered-video assessment remain outside this change.

API additions:

- `GET /api/analyze/:videoId/virality`: saved storyboard reviews, or the review snapshot associated with a cutdown.
- `POST /api/analyze/:videoId/virality` with `storyboard_id`: review a current storyboard revision, reusing cached results where available.
- `POST /api/master/:videoId/storyboards/accept`: accepts optional Boolean `add_text` and `add_broll` (both default false), and an optional `revision` guard. Requested additions require a review of the current storyboard. The response includes warnings about incomplete B-roll placement.

Verification: `node --import tsx --test scripts/virality.test.ts scripts/project-storage.test.ts scripts/agent-kit.test.ts`. Tests use a stubbed evaluator and temporary media, including a real FFmpeg export. `STORYBOARD_DRY_RUN=1` skips automatic AI reviews during the existing offline generation workflow.
