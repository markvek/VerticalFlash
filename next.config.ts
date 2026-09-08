import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module (Skia canvas for PNG text overlays) — must not be bundled
  serverExternalPackages: ["@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/settings/agent-kit/*": ["./agent-kit/README.md", "./agent-kit/mcp/*.json", "./agent-kit/mcp/*.mjs", "./agent-kit/mcp/test/*.mjs", "./agent-kit/verticalflash-video/**/*.md"],
  },
};

export default nextConfig;
