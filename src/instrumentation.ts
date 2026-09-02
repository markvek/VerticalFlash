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
    getBrandConfig();
    await ensureDataDirs();
  }
}
