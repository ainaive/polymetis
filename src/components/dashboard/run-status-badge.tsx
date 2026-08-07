import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";

/**
 * A run's status, localized.
 *
 * The replay header renders the raw enum value, which is English regardless of
 * locale. The dashboard is a list of a person's own runs, so it is the wrong
 * place to start showing them database values.
 */
export function RunStatusBadge({ status }: { status: string }) {
  const t = useTranslations("dashboard.status");

  const variant =
    status === "succeeded"
      ? ("secondary" as const)
      : status === "queued" || status === "running"
        ? ("outline" as const)
        : ("destructive" as const);

  return (
    <Badge variant={variant} className="shrink-0">
      {t(isKnown(status) ? status : "unknown")}
    </Badge>
  );
}

const KNOWN = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

/**
 * A type predicate, not a boolean.
 *
 * `status` arrives as a plain string from the database. Returning boolean
 * leaves it a string at the call site, so next-intl's typed catalog cannot
 * check the key — and a status added to the enum without a message would fail
 * at runtime instead of in tsc.
 */
function isKnown(status: string): status is (typeof KNOWN)[number] {
  return (KNOWN as readonly string[]).includes(status);
}
