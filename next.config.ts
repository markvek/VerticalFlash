import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module (Skia canvas for PNG text overlays) — must not be bundled
  serverExternalPackages: ["@napi-rs/canvas"],
};

export default nextConfig;
