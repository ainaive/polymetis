import { defineRouting } from "next-intl/routing";

// localePrefix "always" so every URL carries its locale (/en/..., /zh/...).
// This is deliberate and differs from a cookie-based locale: gallery and
// replay URLs are public, shareable, and SEO-facing, and a shared link has to
// carry the language it was read in.
export const routing = defineRouting({
  locales: ["en", "zh"],
  defaultLocale: "en",
  localePrefix: "always",
});

export type Locale = (typeof routing.locales)[number];
