// Every edit-state sidecar kept under analysis/<videoId>.<kind>.json. Shared
// by the downloads listing (last-edited mtime), delete, and fork so a new
// sidecar kind only has to be registered once.
export const SIDECAR_KINDS = [
  "timeline-history",
  "framing",
  "broll",
  "model-selection",
  "recommendations",
  "generation",
  "edit-notes",
  "text-overlays",
  "captions",
  "variations",
  "project",
  // Storyboard flow (master projects): the timed transcript segments and
  // the generated storyboards
  "segments",
  "storyboards",
] as const;

export type SidecarKind = (typeof SIDECAR_KINDS)[number];
