import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // The worker and the web app ship as separate images; standalone keeps the
  // web image small enough to be worth building on every merge.
  output: "standalone",
};

export default withNextIntl(nextConfig);
