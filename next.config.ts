import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The worker and the web app ship as separate images; standalone keeps the
  // web image small enough to be worth building on every merge.
  output: "standalone",
};

export default nextConfig;
