import { promises as fs } from "fs";
import { execFileAsync } from "./ffmpeg";
import { join, extname } from "path";
import { tmpdir } from "os";
import {
  fetchMusicDetail,
  fetchVideoDetail,
  type AppMusicInfo,
} from "./tikhub";
import {
  AUDIO_EXTENSIONS,
  MusicLibraryZ,
  isValidMusicFilename,
  type MusicLibrary,
  type MusicTrack,
} from "./music-schema";
import { MUSIC_DIR } from "./paths";
export { MUSIC_DIR } from "./paths";

export const MUSIC_METADATA_FILE = join(MUSIC_DIR, ".metadata.json");
export const MUSIC_COVERS_DIR = join(MUSIC_DIR, ".covers");

const DOWNLOAD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

export function musicPath(filename: string): string {
  return join(MUSIC_DIR, filename);
}

export function musicCoverPath(filename: string): string {
  return join(MUSIC_COVERS_DIR, `${filename}.jpg`);
}

export async function probeAudioDuration(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      path,
    ]);
    const duration = parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0
      ? Math.round(duration * 10) / 10
      : null;
  } catch {
    return null;
  }
}

async function readMetadata(): Promise<MusicLibrary> {
  try {
    const raw = await fs.readFile(MUSIC_METADATA_FILE, "utf8");
    const parsed = MusicLibraryZ.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // first run, or unreadable — start empty
  }
  return { tracks: [], lastUpdated: new Date().toISOString() };
}

async function saveMetadata(library: MusicLibrary): Promise<void> {
  await fs.mkdir(MUSIC_DIR, { recursive: true });
  // Temp-file + rename so a crash mid-write can't truncate the library
  const tmp = `${MUSIC_METADATA_FILE}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify(MusicLibraryZ.parse(library), null, 2)
  );
  await fs.rename(tmp, MUSIC_METADATA_FILE);
}

// Scan music/ and merge with the metadata file: files dropped into the
// folder by hand become "local" tracks (probed for duration), entries whose
// file disappeared are dropped. Persists when anything changed.
export async function loadMusicLibrary(): Promise<MusicLibrary> {
  await fs.mkdir(MUSIC_DIR, { recursive: true });
  const entries = await fs.readdir(MUSIC_DIR).catch(() => [] as string[]);
  const audioFiles = entries.filter(
    (f) => !f.startsWith(".") && AUDIO_EXTENSIONS.includes(extname(f).toLowerCase())
  );

  const metadata = await readMetadata();
  const byName = new Map(metadata.tracks.map((t) => [t.filename, t]));
  const now = new Date().toISOString();
  let changed = false;

  const tracks: MusicTrack[] = [];
  for (const filename of audioFiles) {
    const existing = byName.get(filename);
    if (existing) {
      if (existing.duration == null) {
        const duration = await probeAudioDuration(musicPath(filename));
        if (duration != null) {
          existing.duration = duration;
          existing.updatedAt = now;
          changed = true;
        }
      }
      tracks.push(existing);
      continue;
    }
    changed = true;
    tracks.push({
      filename,
      title: filename.replace(/\.[^.]+$/, ""),
      author: "",
      duration: await probeAudioDuration(musicPath(filename)),
      source: "local",
      acquisition: "local",
      sourceUrl: null,
      tiktokMusicId: null,
      tiktokVideoId: null,
      originalSound: false,
      cover: await fs
        .access(musicCoverPath(filename))
        .then(() => true)
        .catch(() => false),
      createdAt: now,
      updatedAt: now,
    });
  }
  if (tracks.length !== metadata.tracks.length) changed = true;

  const library: MusicLibrary = {
    tracks: tracks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    lastUpdated: changed ? now : metadata.lastUpdated,
  };
  if (changed) await saveMetadata(library);
  return library;
}

export async function findMusicTrack(
  filename: string
): Promise<MusicTrack | null> {
  if (!isValidMusicFilename(filename)) return null;
  const library = await loadMusicLibrary();
  return library.tracks.find((t) => t.filename === filename) ?? null;
}

export async function deleteMusicTrack(filename: string): Promise<boolean> {
  if (!isValidMusicFilename(filename)) return false;
  const library = await loadMusicLibrary();
  const index = library.tracks.findIndex((t) => t.filename === filename);
  if (index === -1) return false;
  await fs.unlink(musicPath(filename)).catch(() => {});
  await fs.unlink(musicCoverPath(filename)).catch(() => {});
  library.tracks.splice(index, 1);
  library.lastUpdated = new Date().toISOString();
  await saveMetadata(library);
  return true;
}

// ---------------------------------------------------------------------------
// Acquisition from a TikTok URL

export type TikTokRef =
  | { kind: "video"; id: string }
  | { kind: "music"; id: string };

// Recognizes post links (/@user/video/<id>, /v/<id>, /t/<code>,
// vm.tiktok.com/<code>), music/sound pages (/music/<slug>-<id>) and bare
// numeric ids. Short links are resolved by following their redirect.
export async function resolveTikTokRef(input: string): Promise<TikTokRef> {
  const trimmed = input.trim();
  if (/^\d{6,}$/.test(trimmed)) return { kind: "video", id: trimmed };

  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error("That doesn't look like a TikTok link");
  }

  const fromPath = (u: URL): TikTokRef | null => {
    const music = u.pathname.match(/\/music\/[^/]*?(\d{6,})\/?$/);
    if (music) return { kind: "music", id: music[1] };
    const video = u.pathname.match(/\/(?:video|v|embed\/v2|embed)\/(\d{6,})/);
    if (video) return { kind: "video", id: video[1] };
    return null;
  };

  const direct = fromPath(url);
  if (direct) return direct;

  // Short links (vm.tiktok.com/xyz, tiktok.com/t/xyz) redirect to the full
  // post URL — read the Location header without downloading the page
  if (
    /tiktok\.com$/i.test(url.hostname) ||
    /^(vm|vt|m)\.tiktok\.com$/i.test(url.hostname)
  ) {
    let current = url.toString();
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": DOWNLOAD_UA },
      });
      const location = res.headers.get("location");
      if (!location) break;
      const next = new URL(location, current);
      const ref = fromPath(next);
      if (ref) return ref;
      current = next.toString();
    }
  }

  throw new Error(
    "Could not find a video or music id in that link — paste a TikTok post or sound URL"
  );
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": DOWNLOAD_UA } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024) throw new Error("download returned no data");
  await fs.writeFile(dest, buffer);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
}

function musicId(info: AppMusicInfo): string | null {
  if (info.id_str) return info.id_str;
  if (info.id != null) return String(info.id);
  return null;
}

// Cover art is served as HEIC, which ffmpeg can't read; macOS's sips can.
// Best-effort: a missing cover never fails the acquisition.
async function saveCover(info: AppMusicInfo, filename: string): Promise<boolean> {
  const url =
    info.cover_large?.url_list?.[0] ?? info.cover_medium?.url_list?.[0];
  if (!url) return false;
  const tmp = join(tmpdir(), `music-cover-${Date.now()}`);
  try {
    await downloadToFile(url, `${tmp}.heic`);
    await fs.mkdir(MUSIC_COVERS_DIR, { recursive: true });
    const dest = musicCoverPath(filename);
    try {
      await execFileAsync("sips", [
        "-s",
        "format",
        "jpeg",
        `${tmp}.heic`,
        "--out",
        dest,
      ]);
    } catch {
      // Not macOS or not HEIC after all — let ffmpeg try
      await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", `${tmp}.heic`, dest]);
    }
    return true;
  } catch (error) {
    console.error("cover art download failed:", error);
    return false;
  } finally {
    await fs.unlink(`${tmp}.heic`).catch(() => {});
  }
}

export interface AcquireResult {
  track: MusicTrack;
  // true when the track was already in the library (same TikTok music id)
  existing: boolean;
}

// Add a song to the library from a TikTok post or sound link. Prefers the
// music's own play_url (the clean track); when a post's sound has none, the
// post video itself is downloaded and its audio extracted with ffmpeg -vn
// ("video mix" — whatever the creator mixed over the footage).
export async function acquireFromTikTok(input: string): Promise<AcquireResult> {
  const ref = await resolveTikTokRef(input);

  let info: AppMusicInfo | null = null;
  let videoPlayUrl: string | null = null;
  let videoId: string | null = null;
  if (ref.kind === "music") {
    info = await fetchMusicDetail(ref.id);
  } else {
    const detail = await fetchVideoDetail(ref.id);
    videoId = detail.aweme_id;
    videoPlayUrl = detail.video.play_addr.url_list[0] ?? null;
    info = detail.music ?? null;
    // Posts sometimes carry only a stub music object; the detail endpoint
    // has the play_url
    const id = info ? musicId(info) : null;
    if (id && !info?.play_url?.url_list?.length) {
      try {
        info = await fetchMusicDetail(id);
      } catch (error) {
        console.error("music detail lookup failed, using post payload:", error);
      }
    }
  }
  if (!info && !videoPlayUrl) {
    throw new Error("This post has no music and no downloadable video");
  }

  const id = info ? musicId(info) : null;
  const library = await loadMusicLibrary();
  if (id) {
    const dupe = library.tracks.find((t) => t.tiktokMusicId === id);
    if (dupe) return { track: dupe, existing: true };
  }

  const title =
    info?.title?.trim() || (videoId ? `TikTok ${videoId}` : `TikTok ${ref.id}`);
  const author =
    info?.author?.trim() || info?.owner_nickname?.trim() || info?.owner_handle || "";
  const stem = `${slugify(title) || "track"}-${id ?? ref.id}`;

  await fs.mkdir(MUSIC_DIR, { recursive: true });
  const playUrl = info?.play_url?.url_list?.[0] ?? null;
  let filename: string;
  let acquisition: MusicTrack["acquisition"];

  const tryPlayUrl = async (): Promise<boolean> => {
    if (!playUrl) return false;
    const dest = musicPath(`${stem}.mp3`);
    try {
      await downloadToFile(playUrl, dest);
      // Whatever the CDN served must be decodable audio
      if ((await probeAudioDuration(dest)) == null) {
        throw new Error("play_url returned an unreadable file");
      }
      return true;
    } catch (error) {
      console.error("music play_url download failed:", error);
      await fs.unlink(dest).catch(() => {});
      return false;
    }
  };

  if (await tryPlayUrl()) {
    filename = `${stem}.mp3`;
    acquisition = "play_url";
  } else if (videoPlayUrl) {
    // Fallback: the post's video, audio track copied out as-is
    const tmpVideo = join(tmpdir(), `music-preview-${Date.now()}.mp4`);
    filename = `${stem}.m4a`;
    try {
      await downloadToFile(videoPlayUrl, tmpVideo);
      await execFileAsync("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-i",
        tmpVideo,
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        musicPath(filename),
      ]);
    } finally {
      await fs.unlink(tmpVideo).catch(() => {});
    }
    acquisition = "video_mix";
  } else {
    throw new Error(
      "The sound has no playable URL and the link isn't a post we can extract audio from"
    );
  }

  const duration = await probeAudioDuration(musicPath(filename));
  const hasCover = info ? await saveCover(info, filename) : false;
  const now = new Date().toISOString();
  const track: MusicTrack = {
    filename,
    title: acquisition === "video_mix" ? `${title} (video mix)` : title,
    author,
    duration,
    source: "tiktok",
    acquisition,
    sourceUrl: input.trim(),
    tiktokMusicId: id,
    tiktokVideoId: videoId,
    originalSound: Boolean(info?.is_original_sound),
    cover: hasCover,
    createdAt: now,
    updatedAt: now,
  };

  // Re-read: another add may have landed while we were downloading
  const fresh = await loadMusicLibrary();
  fresh.tracks = [track, ...fresh.tracks.filter((t) => t.filename !== filename)];
  fresh.lastUpdated = now;
  await saveMetadata(fresh);
  return { track, existing: false };
}
