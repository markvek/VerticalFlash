// Shared videoId helpers. Pure module with no imports so client bundles
// (e.g. the downloads viewer page) can use it without dragging in server-only
// dependencies like @google/genai via generation-schema.ts.

// Extract the local videoId from a download filename.
// Matches authorHandle_1234.mp4 and forked copies like authorHandle_1234-v2.mp4.
export function extractVideoId(filename: string): string | null {
  const match = filename.match(/(?:^|_)(\d+(?:-v\d+)?)\.(?:mp4|mov)$/i);
  if (match) return match[1];

  // Fallback: entire filename minus extension (uploads without the underscore pattern)
  const extensionless = filename.replace(/\.(?:mp4|mov)$/i, "");
  return extensionless || null;
}

// Safe for use as a path segment: excludes ".", "/" and "\".
export function isValidVideoId(id: string): boolean {
  return /^[\w-]+$/.test(id);
}

// "123-v2" -> { baseId: "123", version: 2 }; unversioned ids are version 1.
export function splitVersion(id: string): { baseId: string; version: number } {
  const match = id.match(/^(.*?)-v(\d+)$/);
  if (match && match[1]) {
    return { baseId: match[1], version: parseInt(match[2], 10) };
  }
  return { baseId: id, version: 1 };
}
