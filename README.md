# VerticalFlash

Scan TikTok for short-form videos that are working, analyze them shot by shot
with Gemini, and remake them from your own brand's clip library. Runs locally,
one user, no database.

## What it does

The start page offers five ways to begin a video:

- **Remake from inspiration.** Scan TikTok niches (hashtags, keywords,
  competitor accounts) through TikHub, pick a winning video, download it, and
  let Gemini split it into shots and tag them. The editor then matches each
  shot to clips from your library, lets you trim and swap clips, edit on-screen
  text, and renders a new vertical video with ffmpeg.
- **Iterate on a top video.** Pull your own account's published videos with
  their stats, pick one that did well, and get stat-grounded suggestions for an
  alternate version built from the same library.
- **Custom video from a prompt.** Describe the video you want. Gemini plans
  shots your library can fill, or generates missing shots with the Gemini video
  model.
- **Start from a song.** Pick a track first (from TikTok or your own files),
  then build a video paced to the music.
- **Storyboard shorts from your own footage.** Upload a talking-head or
  product recording (or several clips, joined in order) as a "master".
  WhisperX transcribes it with word-level timing, Gemini reads the
  transcript into segments with roles and hook scores, and you ask for
  1-5 storyboards at the lengths you want. Each storyboard is hook → main
  → end beats cut from the master; accepting one cuts a real short (with
  the speaker's own audio) that opens in the same editor. See
  "Storyboard flow" below.

Rendered videos can be uploaded straight to TikTok drafts, and an analytics
page matches published posts back to local renders.

## Prerequisites

- Node 20 or newer
- ffmpeg and ffprobe on your PATH
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - Windows or other: https://ffmpeg.org/download.html
- A [TikHub](https://tikhub.io) API key (scanning and downloads)
- A [Gemini](https://aistudio.google.com/apikey) API key (analysis, matching,
  planning, generation)
- Optional: a TikTok developer app, for uploading to drafts and pulling your
  own account's stats
- Optional: [WhisperX](https://github.com/m-bain/whisperX) for word-accurate
  cut points in the storyboard flow (`uv tool install whisperx` or
  `pipx install whisperx`; the first run downloads its models). Without it,
  masters fall back to Gemini's approximate timing.

## Setup

```
git clone https://github.com/markvek/VerticalFlash.git
cd VerticalFlash
npm install
cp .env.example .env.local            # add your API keys
cp brand.config.example.json brand.config.json   # describe your product
npm run dev
```

Open http://localhost:3000.

Drop your raw footage into the `library/` folder (created on first run), then
open the **Clip library** page and run "Analyze with Gemini" on each clip, or
batch the whole folder from the terminal:

```
npm run analyze:library -- --dry-run   # list what would run
npm run analyze:library                # analyze every un-analyzed clip
```

Songs go in `music/` or get imported from TikTok inside the app.

## Storyboard flow

Start page → **Storyboard shorts from your own footage** (`/storyboard`):

1. Upload clips (browser uploads are capped at 500 MB each; drop bigger
   files into `library/` and click Refresh) and pick the ones to join, in
   order. One clip is fine.
2. Choose the timing engine. **WhisperX** gives word-level timestamps, so
   cuts land in the breath around a sentence. **Gemini** needs no install
   but its timestamps drift by up to seconds on long files; they are
   tightened against ffmpeg silence detection and flagged as approximate.
3. "Build master and analyze" joins the clips into `storyboards/master-*.mp4`,
   transcribes, and writes `analysis/<id>.segments.json`: every word's
   time, the silences, and Gemini's segments with a role (hook, claim, demo,
   proof, objection, cta, filler) and a hook score.
4. In **Storyboarding**, set how many ideas, the length (one
   for all or one per idea), pacing, whether library B-roll may cover main
   beats, and an optional brief. Generate, preview a storyboard in the
   video, and choose **Start Edit** for the ones you like. Each edit cuts the beats
   into `editing/short-*.mp4` with the audio intact and provides a link to the
   editor, where every beat renders from the short's own footage ("Use
   original footage" per shot) and the audio option defaults to Original.

**Add Footage** includes previously uploaded local library clips in the current
story without changing the original master. Saved timed transcript segments
from earlier storyboard projects return as selectable transcript boxes. When
only a whole-clip analysis exists, it appears as one segment; the app does not
invent word timings or run another analysis. Footage without saved analysis
cannot be included yet. **Upload Footage** explicitly uploads and analyzes new
clips through the existing analysis service.

Included footage references and cached transcript segments are saved locally
in `storyboards/<master-id>/footage/manifest.json`; videos stay in `library/`.
Storyboard cards have fix notes and black placeholders for missing thumbnails.
Fix notes carry into the editing project. Caption controls remain in Editing,
not Storyboarding. Local storage does not change the existing cloud analysis
and storyboard-generation integrations.

The sidebar separates **Storyboarding** source projects from **Editing**
projects. Each idea is saved in `storyboards/<master-id>/<storyboard-id>.json`.
Generating more ideas keeps all earlier designs. Changing an idea saves its
previous revision under `storyboards/<master-id>/revisions/`; accepting it
creates a separate editing video with a storyboard snapshot in its metadata.
Deleting an edit keeps its source and storyboards. Sources referenced by
saved storyboards or edits cannot be deleted through the project list.

Existing projects in `downloads/` remain accessible at their old URLs. Old
storyboard sidecars are copied into individual files on the next generation
or edit, and the original sidecar is retained. This preserves existing saved
ideas; it cannot recover generations overwritten before this change.

Environment (all optional; see `.env.example`): `TRANSCRIBER`,
`WHISPERX_BIN`, `WHISPERX_MODEL` (default `large-v3-turbo`),
`WHISPERX_LANGUAGE`, `WHISPERX_DEVICE`. `STORYBOARD_DRY_RUN=1` skips
Gemini and builds segments and storyboards by rule from the WhisperX
sentences, for free end-to-end testing.

## Connecting an agent

Open **Settings** (`/settings`) to download the MCP connector kit, a client
configuration example, and Markdown guides for creative direction,
storyboarding, editing, and B-roll. The kit contains a runnable local stdio
server; see [agent-kit/README.md](agent-kit/README.md) for installation and
supported tools. It connects to the existing app on the same computer.
Cloud-only clients need a future authenticated remote adapter.

The connector uses existing project APIs and provider configuration. It does
not yet add cross-client revision protection or retry-safe jobs for every
operation. Coordinate browser and agent edits, and inspect project state
after an interrupted write before repeating it.

## Configuring your brand

Everything product-specific lives in `brand.config.json`. The example file
describes a plush duck sold as a car accessory; replace it with your own:

| Field | Used for |
|---|---|
| `name` | Prompts and page titles ("the Acme brand account") |
| `product.shortName` | Casual copy: "make it about the duck" |
| `product.description` | One-line description in every analysis and planning prompt |
| `product.character` | Verbatim sentence for AI video generation, so generated shots show the same subject. Defaults to `description`. |
| `product.presenceRule` | When the cataloging model should mark a clip as showing the product |
| `categories` | Footage categories for your library. Must include `product_showcase` and `other`. |
| `tags` | Brand-specific terms added to the shot-tag vocabulary. The clip matcher uses exact tag intersection, so re-run "Tag shots" on downloaded videos after changing these. |
| `libraryDir` | Folder name for your clips under the data root. Default `library`. |

The file is read once at server start. Restart `npm run dev` after editing it.
Without the file, the app runs with a generic placeholder brand and logs a
warning.

## Where data lives

All runtime data sits next to the code by default and is gitignored:

| Path | Contents |
|---|---|
| `downloads/` | Downloaded TikTok videos, legacy projects, and the display-name index |
| `storyboards/` | Master footage, independently saved storyboard ideas, and previous revisions |
| `editing/` | Accepted shorts and new editing projects, with metadata and storyboard snapshots |
| `analysis/` | Per-video analysis, tags, edit state, captions, variations, master segments, and legacy storyboard sidecars |
| `library/` | Your clip library and its `.metadata.json` catalog |
| `music/` | Imported tracks and cover art |
| `renders/` | Rendered remakes and their manifests |
| `generated/` | AI-generated clips, per video |
| `publishes.json`, `tikhub-cache.json`, `tiktok-token.json` | Upload log, analytics cache, TikTok OAuth token |

Set `DATA_DIR` in `.env.local` to keep all of it outside the repo.
These local files are the authoritative saved projects; no cloud project
store is required. Gemini analysis still sends footage to Gemini, and
publishing uploads the selected render. Local storage does not imply
entirely offline AI processing.

## Costs

Both external APIs are metered. Rough shape of the spend:

- **TikHub**: one call per scan seed and per video download. Scans are capped
  at five pages per seed.
- **Gemini text/vision model**: one call per video analysis, tag pass, clip
  match, caption draft, and library clip analysis. The editor shows token
  counts and an estimated cost per call.
- **Gemini video model**: per-shot "Generate clip" and "Extend" are the one
  expensive feature. Set `GENAI_VIDEO_DRY_RUN=1` to swap in free ffmpeg test
  patterns while you learn the flow, and
  `NEXT_PUBLIC_GEMINI_VIDEO_PRICE_PER_SEC` to see dollar estimates.

## Security model

This is a single-user tool for your own machine.

- **There is no authentication.** Every API route is open. Only run it on
  localhost. Never bind it to a public interface or deploy it as-is, or
  strangers get your Gemini spend, your TikHub quota, your TikTok upload
  capability, and read access to your media folders.
- `.env.local` holds your API keys and, optionally, a TikTok session cookie.
  Keep it out of version control (the `.gitignore` already does).
- `tiktok-token.json` holds a live TikTok OAuth token and is written with
  owner-only permissions.

## HTTPS for TikTok login

TikTok rejects http OAuth callbacks. To use upload and account stats locally:

```
brew install mkcert            # or see https://github.com/FiloSottile/mkcert
mkcert -install
mkdir -p certificates
mkcert -key-file certificates/localhost-key.pem -cert-file certificates/localhost.pem localhost
npm run dev:https
```

Then set `TIKTOK_REDIRECT_URI=https://localhost:3000/api/tiktok/auth/callback`
in `.env.local` and the same URL in your TikTok app settings.

## Development

```
npm run typecheck
npm run test:projects  # isolated local storage and ffmpeg workflow tests
npm run lint
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

## License

[MIT](LICENSE)

### Storyboard model benchmarks

Start on `/storyboard`, choose **Benchmark**, and compare four models using one
shared prompt, core-footage selection, and optional B-roll pool. Each version
generates its own storyboard and automatically applies B-roll for comparison.
See [setup, workflow, and validation](docs/storyboard-benchmarks.md).
