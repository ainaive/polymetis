import type { Metadata } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { SiteHeader } from "@/components/site-header";
import { routing } from "@/i18n/routing";

import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: t("title"), description: t("description") };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  // Opts this layout into static rendering; without it every page under
  // [locale] is forced dynamic.
  setRequestLocale(locale);

  return (
    <html lang={locale} suppressHydrationWarning>
      {/* A flex column so a page can fill the space under the header rather
          than assuming the whole viewport — the replay player needs the
          remainder, not 100dvh. */}
      <body className="bg-background text-foreground flex min-h-dvh flex-col antialiased">
        <NextIntlClientProvider>
          <SiteHeader />
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
