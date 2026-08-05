import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

// Use these instead of next/link and next/navigation anywhere inside
// src/app/[locale] — they keep the active locale prefix on every URL.
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
