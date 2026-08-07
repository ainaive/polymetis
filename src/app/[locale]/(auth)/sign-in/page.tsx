import { getTranslations, setRequestLocale } from "next-intl/server";

import { AuthForm } from "@/components/auth/auth-form";
import { getSession } from "@/auth/session";
import { githubConfigured } from "@/env";
import { Link, redirect } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";

export default async function SignInPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Already signed in: the form would work, but landing on it from a bookmark
  // and being asked to sign in again reads as though the session was lost.
  if (await getSession()) redirect({ href: "/dashboard", locale });

  const t = await getTranslations("auth");

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-12">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("signInTitle")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("signInSubtitle")}</p>
      </div>

      <AuthForm
        mode="sign-in"
        githubEnabled={githubConfigured}
        labels={{
          email: t("email"),
          password: t("password"),
          name: t("name"),
          submit: t("signInSubmit"),
          github: t("continueWithGithub"),
          or: t("or"),
          generic: t("genericError"),
        }}
      />

      <p className="text-muted-foreground text-sm">
        {t("noAccount")}{" "}
        <Link href="/sign-up" className="text-foreground underline underline-offset-4">
          {t("signUpTitle")}
        </Link>
      </p>
    </div>
  );
}
