# VerticalFlash

Scan TikTok for short-form videos that are working, analyze them shot by shot
with Gemini, and remake them from your own brand's clip library. Runs locally,
one user, no database.

## What it does

The start page offers four ways to begin a video:

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
| `downloads/` | Downloaded TikTok videos and created projects, with `.metadata.json` sidecars |
| `analysis/` | Per-video Gemini analysis, tags, recommendations, captions, variations |
| `library/` | Your clip library and its `.metadata.json` catalog |
| `music/` | Imported tracks and cover art |
| `renders/` | Rendered remakes and their manifests |
| `generated/` | AI-generated clips, per video |
| `publishes.json`, `tikhub-cache.json`, `tiktok-token.json` | Upload log, analytics cache, TikTok OAuth token |

Set `DATA_DIR` in `.env.local` to keep all of it outside the repo.

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
npm run lint
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.

## License

[MIT](LICENSE)
