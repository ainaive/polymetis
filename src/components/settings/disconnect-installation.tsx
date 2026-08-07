"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";

export function DisconnectInstallationButton({
  installationId,
  label,
  failedLabel,
}: {
  installationId: string;
  label: string;
  failedLabel: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex items-center gap-2">
      {failed ? (
        <span role="alert" className="text-destructive text-xs">
          {failedLabel}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setFailed(false);
          try {
            const response = await fetch(
              `/api/github/callback?installation_id=${encodeURIComponent(installationId)}`,
              { method: "DELETE" },
            );
            // The status was previously ignored, so a refused disconnect looked
            // exactly like a successful one and the row simply stayed put.
            if (!response.ok) {
              setFailed(true);
              return;
            }
            // Disconnecting here only forgets the installation. The App stays
            // installed on GitHub until it is removed there, which is why the
            // page also links to GitHub's own settings.
            router.refresh();
          } catch {
            setFailed(true);
          } finally {
            // In a finally: on a rejection the button would otherwise stay
            // disabled and the person could not retry without reloading.
            setPending(false);
          }
        }}
      >
        {label}
      </Button>
    </div>
  );
}
