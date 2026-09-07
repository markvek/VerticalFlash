// Runs once when the Next.js server starts. Creates the data directories and
// validates brand.config.json so a bad config fails loudly at boot instead of
// on the first request.
//
// The `if` block (not an early return) matters: webpack only skips resolving
// the Node-only imports for the edge bundle when they sit inside a branch it
// can prove is dead.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getBrandConfig } = await import("./lib/config");
    const { ensureDataDirs } = await import("./lib/paths");
    const { detectWhisperX, transcriberDefault } = await import("./lib/whisperx");
    getBrandConfig();
    await ensureDataDirs();
    // Optional word-level timing engine for the storyboard flow: report
    // what masters will use, without failing boot
    detectWhisperX()
      .then((d) => {
        if (d.available) {
          console.log(
            `[whisperx] found ${d.binary} (v${d.version}); masters use ${transcriberDefault()} timing`
          );
        } else {
          console.log(
            `[whisperx] not found — masters fall back to Gemini timing (approximate). Install: uv tool install whisperx`
          );
        }
      })
      .catch(() => {});
  }
}
