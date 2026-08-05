import { getTranslations, setRequestLocale } from "next-intl/server";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("home");

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-6 px-6">
      <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
        {t("tagline")}
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        {t("headline")}
      </h1>
      <p className="text-muted-foreground max-w-2xl text-lg text-pretty">
        {t("subhead")}
      </p>
      <p className="text-muted-foreground/70 text-sm">{t("scaffoldNotice")}</p>
    </main>
  );
}
