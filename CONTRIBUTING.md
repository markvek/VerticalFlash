# Contributing

Thanks for your interest in VerticalFlash. This is a small project, so the
process is light.

## Setup

1. Install Node 20+ and ffmpeg (see the README for platform commands).
2. `npm install`
3. `cp .env.example .env.local` and fill in the keys you need.
4. `cp brand.config.example.json brand.config.json` and describe your product.
5. `npm run dev`

## Before opening a pull request

Run all three and make sure they pass:

```
npm run typecheck
npm run lint
npm run build
```

CI runs the same commands on every pull request.

## Guidelines

- Keep pull requests focused on one change.
- Anything brand-specific belongs in `brand.config.json`, not in code or
  prompts. Use `getBrandConfig()` on the server and `useBrand()` in client
  components.
- All on-disk paths come from `src/lib/paths.ts`. Do not call
  `process.cwd()` elsewhere.
- Anything that shells out to ffmpeg or ffprobe should use the shared
  `execFileAsync` from `src/lib/ffmpeg.ts` so a missing binary produces a
  readable error.
- Never commit API keys, cookies, tokens, or media files. The `.gitignore`
  covers the data directories; keep it that way.

## Reporting bugs

Open an issue with the steps to reproduce, what you expected, what happened,
and the relevant terminal output. Redact any keys or cookies before pasting.
