"use client";

import { Languages } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { cn } from "@/lib/utils";

/**
 * Move between locales without leaving the page.
 *
 * `usePathname` from @/i18n/navigation returns the path *without* the locale
 * prefix, so pushing it with a different locale lands on the same page in the
 * other language. Linking to `/` instead would drop someone reading a replay
 * back to the homepage, which is the kind of thing that stops people switching
 * at all.
 *
 * Locale lives in the URL rather than a cookie (an AGENTS.md rule): gallery and
 * replay links are public and shareable, so a link has to carry the language it
 * was read in.
 */
export function LocaleSwitcher({
  current,
  labels,
}: {
  current: string;
  labels: { switch: string; names: Record<string, string> };
}) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="flex items-center" role="group" aria-label={labels.switch}>
      <Languages className="text-muted-foreground mr-1 size-3.5" aria-hidden />
      {routing.locales.map((locale) => (
        <Button
          key={locale}
          variant="ghost"
          size="sm"
          aria-current={locale === current ? "true" : undefined}
          className={cn(
            "h-7 px-1.5 text-xs",
            locale === current
              ? "text-foreground font-medium"
              : "text-muted-foreground",
          )}
          onClick={() => {
            if (locale === current) return;
            router.push(pathname, { locale });
          }}
        >
          {labels.names[locale] ?? locale}
        </Button>
      ))}
    </div>
  );
}
