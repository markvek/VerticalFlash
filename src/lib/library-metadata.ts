import type { LibraryClip } from "./library-schema";

const tagKey = (tag: string) => tag.trim().toLowerCase();

// Undefined means no human value yet; null/empty means explicitly cleared.
export function clipDescription(clip: LibraryClip): string {
  return clip.description !== undefined ? clip.description ?? "" : clip.analysis?.description ?? "";
}

export function clipTags(clip: LibraryClip): string[] {
  const rejected = new Set((clip.rejected_tags ?? []).map(tagKey));
  return [...new Set([...(clip.tags ?? []), ...(clip.analysis?.suggested_tags ?? [])].map(tagKey))]
    .filter(tag => tag && !rejected.has(tag));
}

export function rejectedTagsAfterEdit(clip: LibraryClip, tags: string[]): string[] {
  const accepted = new Set(tags.map(tagKey));
  return [...new Set([...(clip.rejected_tags ?? []), ...clipTags(clip)].map(tagKey))]
    .filter(tag => !accepted.has(tag));
}
