import type { NextConfig } from "next";
import { ANTI_FRAMING_HEADERS } from "./src/app/api/review/guard";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // No page of this app may be framed by another site (clickjacking).
  async headers() {
    return [{ source: "/:path*", headers: [...ANTI_FRAMING_HEADERS] }];
  },
};

export default nextConfig;
