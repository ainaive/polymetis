"use client";

import { authClient } from "@/auth/client";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";

export function SignOutButton({ label }: { label: string }) {
  const router = useRouter();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await authClient.signOut();
        // refresh() and not just push(): the header is a server component, so
        // without re-rendering it the page would still show a signed-in nav.
        router.push("/");
        router.refresh();
      }}
    >
      {label}
    </Button>
  );
}
