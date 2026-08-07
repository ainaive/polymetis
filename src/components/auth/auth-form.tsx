"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

import { authClient } from "@/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";

/**
 * Sign in and sign up, which differ by one field and one call.
 *
 * Kept as one component because the two forms have to stay consistent about
 * error handling and where they land afterwards, and two files drift.
 */

export type AuthLabels = {
  email: string;
  password: string;
  name: string;
  submit: string;
  github: string;
  or: string;
  generic: string;
};

export function AuthForm({
  mode,
  labels,
  githubEnabled,
}: {
  mode: "sign-in" | "sign-up";
  labels: AuthLabels;
  githubEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "");

    try {
      const result =
        mode === "sign-up"
          ? await authClient.signUp.email({ email, password, name })
          : await authClient.signIn.email({ email, password });

      if (result.error) {
        // better-auth's message is the useful one — "invalid email or password",
        // "user already exists". Falling back to our own only when it has none.
        setError(result.error.message ?? labels.generic);
        setPending(false);
        return;
      }
    } catch {
      // A rejection, not an error result: the request never reached the server.
      // Without this the button stays disabled with nothing said, and the only
      // way out is a reload.
      setError(labels.generic);
      setPending(false);
      return;
    }

    // Not setPending(false) on success: the push is about to unmount this, and
    // clearing it first shows an enabled button for the frame before navigation.
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        {mode === "sign-up" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">{labels.name}</Label>
            <Input id="name" name="name" autoComplete="name" />
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">{labels.email}</Label>
          <Input id="email" name="email" type="email" required autoComplete="email" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">{labels.password}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          />
        </div>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {labels.submit}
        </Button>
      </form>

      {githubEnabled ? (
        <>
          <div className="text-muted-foreground flex items-center gap-3 text-xs">
            <span className="bg-border h-px flex-1" aria-hidden />
            {labels.or}
            <span className="bg-border h-px flex-1" aria-hidden />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                // Sign-in scopes only. Repository access is a separate
                // consented step through the GitHub App (ADR-0002).
                await authClient.signIn.social({ provider: "github" });
              } catch {
                // On success this navigates away and the reset never runs.
                setError(labels.generic);
                setPending(false);
              }
            }}
          >
            <GithubMark />
            {labels.github}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The GitHub mark, inline.
 *
 * lucide-react dropped brand icons, and a sign-in button that says "Continue
 * with GitHub" next to a generic glyph is harder to recognise than one with the
 * mark people already look for.
 */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
