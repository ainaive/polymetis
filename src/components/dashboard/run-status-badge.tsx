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

const KNOWN = ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"];

function isKnown(status: string): boolean {
  return KNOWN.includes(status);
}
