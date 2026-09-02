import { z } from "zod";

// Music library: music/<filename> audio files plus music/.metadata.json,
// mirroring the clip library pattern (files dropped into the folder are
// picked up on the next scan; the metadata file carries what we know about
// each track). Covers live in music/.covers/<filename>.jpg.

// Default target length for a music-first video: min(song length, this)
export const MUSIC_DEFAULT_MAX_SECONDS = 60;

export const MUSIC_SOURCES = ["tiktok", "local"] as const;

// How the audio file was obtained:
// - play_url: TikHub's music.play_url (the clean track)
// - video_mix: audio track extracted from the post's video with ffmpeg -vn
//   (used when the music has no playable URL)
// - local: dropped into the music/ folder by hand
export const MUSIC_ACQUISITIONS = ["play_url", "video_mix", "local"] as const;

export const MusicTrackZ = z.object({
  filename: z.string(),
  title: z.string(),
  author: z.string(),
  // Seconds, from ffprobe (null when the file could not be probed)
  duration: z.number().nullable(),
  source: z.enum(MUSIC_SOURCES),
  acquisition: z.enum(MUSIC_ACQUISITIONS),
  sourceUrl: z.string().nullable().optional(),
  tiktokMusicId: z.string().nullable().optional(),
  tiktokVideoId: z.string().nullable().optional(),
  // "original sound" on TikTok = the post's own audio, not a licensed song
  originalSound: z.boolean().optional(),
  // A cover image exists at music/.covers/<filename>.jpg
  cover: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MusicTrack = z.infer<typeof MusicTrackZ>;

export const MusicLibraryZ = z.object({
  tracks: z.array(MusicTrackZ),
  lastUpdated: z.string(),
});

export type MusicLibrary = z.infer<typeof MusicLibraryZ>;

export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"];

// Safe as a path segment inside music/: no traversal, no hidden files
export function isValidMusicFilename(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..")
  );
}

// Suggested video length for a track: the whole song up to the cap
export function defaultMusicDuration(trackDuration: number | null): number {
  if (trackDuration == null || trackDuration <= 0) {
    return MUSIC_DEFAULT_MAX_SECONDS;
  }
  return Math.max(
    1,
    Math.round(Math.min(trackDuration, MUSIC_DEFAULT_MAX_SECONDS))
  );
}
