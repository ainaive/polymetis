import "server-only";

import { redirect } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";

import { getSession } from "./session";

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/**
 * The session, or a redirect to sign in.
 *
 * next-intl's `redirect` throws, but its return type is `void`, so TypeScript
 * cannot narrow past a call to it. Doing the narrowing here means one
 * explained assertion instead of one at every protected page.
 */
export async function requireSession(locale: Locale): Promise<Session> {
  const session = await getSession();
  if (!session) redirect({ href: "/sign-in", locale });
  return session as Session;
}
