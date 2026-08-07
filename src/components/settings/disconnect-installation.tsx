"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";

export function DisconnectInstallationButton({
  installationId,
  label,
}: {
  installationId: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await fetch(
          `/api/github/callback?installation_id=${encodeURIComponent(installationId)}`,
          { method: "DELETE" },
        );
        // Disconnecting here only forgets the installation. The App stays
        // installed on GitHub until it is removed there, which is why the page
        // also links to GitHub's own settings.
        router.refresh();
        setPending(false);
      }}
    >
      {label}
    </Button>
  );
}
