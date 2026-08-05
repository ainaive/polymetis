import createMiddleware from "next-intl/middleware";

import { routing } from "@/i18n/routing";

// Next 16 renamed middleware to proxy; the runtime is nodejs and is not
// configurable.
export default createMiddleware(routing);

export const config = {
  matcher: [
    // Everything except API routes, Next internals, and files with an
    // extension (favicon.ico, images, etc.).
    "/((?!api|_next|_vercel|.*\\..*).*)",
  ],
};
