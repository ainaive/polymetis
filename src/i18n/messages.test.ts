import { describe, expect, test } from "bun:test";

import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

import { routing } from "./routing";

/**
 * AGENTS.md requires every user-facing string in both catalogs. That rule was
 * broken once already — the replay event stream shipped hardcoded English
 * inside a localized page — so it is enforced here rather than trusted.
 */

type Catalog = { [key: string]: string | Catalog };

function flatten(catalog: Catalog, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flatten(value, path);
  });
}

function valuesOf(catalog: Catalog, prefix = ""): [string, string][] {
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string"
      ? ([[path, value]] as [string, string][])
      : valuesOf(value, path);
  });
}

/** ICU placeholders and rich-text tags, e.g. {count} and <code>. */
function placeholders(message: string): string[] {
  return [
    ...(message.match(/\{(\w+)\}/g) ?? []),
    ...(message.match(/<(\w+)>/g) ?? []),
  ].sort();
}

const catalogs: Record<string, Catalog> = { en, zh };

describe("message catalogs", () => {
  test("a catalog exists for every configured locale", () => {
    for (const locale of routing.locales) {
      expect(catalogs[locale], `no catalog for locale "${locale}"`).toBeDefined();
    }
  });

  test("every locale defines exactly the same keys", () => {
    const base = flatten(en as Catalog).sort();
    for (const locale of routing.locales) {
      const other = flatten(catalogs[locale]).sort();
      const missing = base.filter((k) => !other.includes(k));
      const extra = other.filter((k) => !base.includes(k));
      expect(missing, `${locale} is missing keys`).toEqual([]);
      expect(extra, `${locale} has keys en does not`).toEqual([]);
    }
  });

  test("no message is empty or whitespace-only", () => {
    for (const locale of routing.locales) {
      for (const [key, value] of valuesOf(catalogs[locale])) {
        expect(value.trim().length, `${locale}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  test("translations use the same placeholders and tags as the base locale", () => {
    // A translation that drops {bytes} or <code> renders a broken string at
    // runtime rather than failing loudly, so it is checked here.
    const base = Object.fromEntries(valuesOf(en as Catalog));
    for (const locale of routing.locales) {
      if (locale === "en") continue;
      for (const [key, value] of valuesOf(catalogs[locale])) {
        expect(placeholders(value), `${locale}.${key} placeholder mismatch`).toEqual(
          placeholders(base[key]),
        );
      }
    }
  });
});
