# Storyboard benchmarks

On `/storyboard`, upload/select the core footage once and name the project.
Open **Benchmark**, enter a shared prompt, duration and pacing, select four
models, and optionally enable **Automatically add B-roll**. Choose the eligible
B-roll pool separately from the core footage. Click **Benchmark — create four
versions** to open the run immediately and watch its progress.

Each model creates one storyboard and selects actual B-roll clips and start
moments for its segments. Previews retain the speaker's audio. The results show
storyboard beats, selected clips, and reasons. Blind review uses a frozen preview;
**Edit a copy** creates a separate editing project. B-roll scores are omitted
when B-roll is disabled. Unfinished variants can be retried before review.

## Configuration

Copy the benchmark section of `.env.example` into `.env.local`, set provider
keys and exact text/vision model IDs from your account, then restart the app.
Comma-separated allowlists support multiple models from the same provider.
The default comparison requires one model each from Gemini, OpenAI, Claude, and
xAI/Grok. All four provider slots remain visible when setup is incomplete.
To compare multiple models from one provider, explicitly select **Choose any four
models**. Unavailable providers are never automatically replaced with Gemini.
The model controls check the provider model lists and disable unavailable
choices. Access to a listed model does not guarantee generation quota.
Claude's list contains dated IDs for some model versions; configured aliases
such as `claude-opus-4-5` are verified with its
[model lookup API](https://platform.claude.com/docs/en/api/http/models/retrieve).
Both aliases and canonical IDs are accepted. For a benchmark pinned to a
specific version, configure the canonical ID returned by Claude.

### Troubleshooting provider access

The access check calls each provider's model-list endpoint before generation.
An explicit rejected-key error means that provider rejected the configured
credential; changing the storyboard prompt or model ID cannot fix that check.
Replace the indicated key in the `.env.local` belonging to the running checkout
and restart the app. Keep one entry per variable to avoid ambiguous edits.
OpenAI uses `OPENAI_API_KEY`, Claude uses `ANTHROPIC_API_KEY`, and xAI uses
`XAI_API_KEY`. These must be API credentials from the respective provider.

OpenAI can return `401` with `invalid_api_key`; Claude can return `401` with
`authentication_error`; xAI can report an incorrect key with `400`. The UI
classifies these responses without exposing provider messages that may echo a
credential. After authentication succeeds, verify the configured model IDs are
available to the account, then check generation billing/quota separately.
Model-list checks are cached for up to 60 seconds.

References: [OpenAI errors](https://developers.openai.com/api/docs/guides/error-codes),
[Claude errors](https://platform.claude.com/docs/en/api/errors), and
[xAI errors](https://docs.x.ai/developers/debugging).

Shared transcript preparation and missing B-roll catalog descriptions currently
use Gemini, so `GEMINI_API_KEY` is required regardless of the four selected models.
Each variant's storyboard and B-roll decisions use its own selected model.
Native video/audio flows on `/create`, `/iterate`, and the standard storyboard
flow expose Gemini model choices; cross-provider comparison is available through
Benchmark. Iteration projects are isolated by source content and selected model.

## What the comparison measures

The same prompt, transcript/segments, B-roll catalog, and sampled B-roll imagery
are supplied to all models. This evaluates storyboard planning and B-roll choices,
not four independent transcription systems. Shared preprocessing provenance is
shown separately. Each B-roll contact sheet samples four moments; this is an
approximation of the clip's action, not exhaustive frame-by-frame inspection.

The runner validates filenames, trim bounds, duration, and rendering success.
Invalid outputs fail explicitly. A model may choose no suitable B-roll, in which
case source footage remains visible. These checks establish mechanical validity;
human review evaluates storytelling and visual relevance. AI-judge scores and
cost estimates are not implemented; token counts and elapsed time are recorded.

## Persistence and operations

Run records live in `benchmarks/<runId>.json`; frozen input metadata, contact
sheets, and immutable previews live in `benchmarks/<runId>/`. Source media hashes
are checked before and after processing. Source media must remain available and
unchanged; the runner fails explicitly if a fingerprint changes. Generated ideas
and editing projects use the existing storyboard/editing stores.

The background worker runs in the local Next.js Node process, with two concurrent
variants. A restart marks interrupted work retryable; it does not automatically
resume paid model calls. Completed stage artifacts are reused on retry. Run one
application writer per data directory: the in-process write locks do not provide
coordination between separate app processes or machines. For hosted serverless
use, replace this worker with a durable external job queue.

## Validation

`npm run test:storyboard-benchmarks` exercises provider request routing and a
full four-variant run with deterministic model responses and real FFmpeg output.
It verifies visible B-roll, source audio, B-roll off, model/input isolation,
no-match handling, invalid trims, failed-stage retry, and scoring bounds.
It does not claim to measure live model quality.

Provider request contracts follow the official documentation:
[OpenAI Responses](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create),
[Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision),
[xAI image understanding](https://docs.x.ai/developers/model-capabilities/images/understanding).
