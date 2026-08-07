"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

import { startRun } from "@/app/[locale]/runs/new/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import type { StartableTemplate } from "@/db/queries/templates";
import type { StartRunOutcome } from "@/lib/runs/start";
import type { TemplateInputField } from "@/lib/templates/contract";

/**
 * The run form, generated from the template's declared inputs.
 *
 * Hand-writing a form per template would mean a template contract that says one
 * thing and a form that asks another. The fields come from `inputSchema`, and
 * the server action validates against the same schema.
 */

export type RunFormLabels = {
  submit: string;
  submitting: string;
  optional: string;
  errorHeading: string;
  quotaAllowance: string;
  quotaConcurrency: string;
  notSignedIn: string;
  unknownTemplate: string;
  fields: Record<string, string>;
  hints: Record<string, string>;
};

export function RunForm({
  locale,
  template,
  labels,
}: {
  locale: Locale;
  template: StartableTemplate;
  labels: RunFormLabels;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrors([]);

    const data = new FormData(event.currentTarget);
    const submitted: Record<string, string> = {};
    for (const field of template.inputSchema.fields) {
      submitted[field.name] = String(data.get(field.name) ?? "");
    }

    const result: StartRunOutcome = await startRun(
      locale,
      template.versionId,
      submitted,
    );

    if (!result.ok) {
      setErrors(result.errors.map((code: string) => translateError(code, labels)));
      setPending(false);
      return;
    }

    // Straight to the run, which is already queued: the live view shows the
    // worker picking it up, so there is nothing useful to stay here for.
    router.push(`/runs/${result.runId}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {template.inputSchema.fields.map((field) => (
        <Field key={field.name} field={field} labels={labels} />
      ))}

      {errors.length > 0 ? (
        <ul role="alert" className="text-destructive flex flex-col gap-1 text-sm">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {pending ? labels.submitting : labels.submit}
      </Button>
    </form>
  );
}

function Field({
  field,
  labels,
}: {
  field: TemplateInputField;
  labels: RunFormLabels;
}) {
  // The catalog is keyed by field name so a template's inputs can be named in
  // both languages; an unknown field falls back to its own name rather than
  // rendering an empty label.
  const label = labels.fields[field.name] ?? field.name;
  const hint = labels.hints[field.name];

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={field.name}>
        {label}
        {!field.required ? (
          <span className="text-muted-foreground font-normal"> {labels.optional}</span>
        ) : null}
      </Label>

      {field.type === "select" ? (
        <select
          id={field.name}
          name={field.name}
          defaultValue={field.defaultValue}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={field.name}
          name={field.name}
          required={field.required}
          maxLength={field.type === "text" ? field.maxLength : undefined}
        />
      )}

      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

/**
 * Server-side codes become sentences here.
 *
 * The action returns codes rather than prose so the messages live in the
 * catalogs; `validateRunInputs` returns English field errors, which are shown
 * as-is until the contract carries localized ones.
 */
function translateError(code: string, labels: RunFormLabels): string {
  switch (code) {
    case "quota-allowance":
      return labels.quotaAllowance;
    case "quota-concurrency":
      return labels.quotaConcurrency;
    case "not-signed-in":
      return labels.notSignedIn;
    case "unknown-template":
      return labels.unknownTemplate;
    default:
      return code;
  }
}
