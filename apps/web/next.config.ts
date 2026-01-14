import type { NextConfig } from "next";
import { dirname } from "path";
import { fileURLToPath } from "url";

const configDir = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  cacheComponents: true,
  distDir: ".next-local",
  turbopack: {
    root: configDir,
  },
};

export default nextConfig;
