# Framing and B-roll Layers

The shared editor at `/editing/[filename]` and `/downloads/[filename]` exposes
framing beside the preview in the **Video Editing** tab. The **Shots** tab holds
the shot cards. Select a main shot, or open a placed B-roll segment and choose
**Frame & Layers** to return to its controls in Video Editing.

- Fill/Fit, drag position, and zoom are independent for each main shot and
  B-roll segment. Pan & Zoom interpolates between Start and End over the current
  segment duration. Coordinates are normalized alignment values, not pixels.
- Center X/Y display the selected layer's center in output pixels (540, 960 is
  centered at 1080x1920). Dragging and numeric entries stay synchronized. Arrow
  keys nudge one pixel; Shift+Arrow nudges ten. Position can extend beyond the
  canvas. The Center position button preserves zoom and edits only the active
  Start/End keyframe. Position guides are editor overlays and are not exported.
- B-roll controls include main-picture visibility, main-picture opacity,
  B-roll opacity, and a background color behind a hidden or faded main picture.
  These controls do not mute narration or remove a speaker's physical background.
- Overlapping B-roll follows track order, with the last active segment on top.
  Its background settings control the main picture underneath every B-roll layer.
- Undo/redo is local to the editing session. Completed gestures are autosaved;
  dragging does not send render requests. Export waits for pending settings saves.

## Storage and Rendering

`analysis/<videoId>.framing.json` is a versioned sidecar with optimistic revision
checks and atomic writes. It is registered for listing, fork, and delete. Each
render manifest records the settings snapshot used for that export.
Optional `offsetX`/`offsetY` values on each frame point are canvas-relative
translations. Missing offsets mean zero, preserving older crop and motion paths.

Preview and export resolve assembled master ranges back to the original library
uploads, including ranges spanning multiple uploads. Missing originals produce
a visible warning and use the assembled crop as a fallback. Source media is not
overwritten. B-roll with saved layer settings uses a temporary alpha-capable
intermediate at export, so Fit margins stay transparent until compositing.

The preview uses the same clip-selection planner as export. Existing optional
AI stages for fix notes and missing trim choices still run only during export;
framing edits themselves invoke no AI. Unpicked clip timing is flagged in the
preview because that export stage can select a different source moment.

Browsers unable to decode an upload (including audio-only HEVC decoding) request
one uncropped H.264 compatibility preview. These files are cached under
`DATA_DIR/.framing-previews`, keyed by source path, size, and modification time.
Changing crop, motion, or opacity never invalidates that cache. The first preview
of an unsupported codec can take time to prepare; exports still use originals.

## Verification

Run `node --import tsx --test scripts/framing.test.ts` for geometry, persistence,
concurrent save conflicts, actual ffmpeg pan/fit pixels, alpha composition,
overlapping layers, narration preservation, original-source joins, forked settings,
and compatibility-cache reuse. Existing project-storage, B-roll resolution, and
shot-retiming tests also cover surrounding workflows.
