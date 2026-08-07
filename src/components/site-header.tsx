import { getTranslations } from "next-intl/server";

import { getSession } from "@/auth/session";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

/**
 * The one place that knows whether anyone is signed in.
 *
 * A server component so the session is read once per request, rather than every
 * page fetching it to decide what to put in its own header.
 */
export async function SiteHeader({ locale }: { locale: string }) {
  const [t, tLocale, session] = await Promise.all([
    getTranslations("nav"),
    getTranslations("locale"),
    getSession(),
  ]);

  return (
    <header className="border-border/60 border-b">
      <nav className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          Polymetis
        </Link>

        <div className="ml-auto flex items-center gap-1">
          <LocaleSwitcher
            current={locale}
            labels={{
              switch: tLocale("switch"),
              names: { en: tLocale("en"), zh: tLocale("zh") },
            }}
          />
          {session ? (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard">{t("dashboard")}</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href="/settings/github">{t("settings")}</Link>
              </Button>
              <SignOutButton label={t("signOut")} />
            </>
          ) : (
            <Button asChild variant="ghost" size="sm">
              <Link href="/sign-in">{t("signIn")}</Link>
            </Button>
          )}
        </div>
      </nav>
    </header>
  );
}
