import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  FileText,
  Flag,
  MessageSquare,
  Play,
  Receipt,
  Wrench,
  XCircle,
} from "lucide-react";

import type { ReplayFrame } from "@/lib/events/fold";
import type { RunEventType } from "@/lib/events/schema";
import { cn } from "@/lib/utils";

const ICONS: Record<RunEventType, typeof Play> = {
  "run.start": Play,
  "step.start": Flag,
  "tool.call": Wrench,
  "tool.result": CheckCircle2,
  "agent.message": MessageSquare,
  "artifact.write": FileText,
  usage: Receipt,
  error: AlertTriangle,
  "run.end": CircleDot,
};

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** One event in the stream. Kept dumb so the player owns all timing state. */
export function EventRow({ frame }: { frame: ReplayFrame }) {
  const failed =
    (frame.type === "tool.result" && !frame.payload.ok) || frame.type === "error";
  const Icon = failed ? XCircle : ICONS[frame.type];

  return (
    <li className="flex gap-3 py-2.5">
      <span className="text-muted-foreground/60 w-10 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums">
        {formatElapsed(frame.offsetMs)}
      </span>
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          failed ? "text-destructive" : "text-muted-foreground",
          frame.type === "step.start" && "text-foreground",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1 text-sm">
        <EventBody frame={frame} />
      </div>
    </li>
  );
}

function EventBody({ frame }: { frame: ReplayFrame }) {
  switch (frame.type) {
    case "run.start":
      return (
        <p className="text-muted-foreground">
          Started <Mono>{frame.payload.templateSlug}</Mono>
          {frame.payload.issue ? (
            <>
              {" on "}
              <Mono>
                {frame.payload.issue.owner}/{frame.payload.issue.name}#
                {frame.payload.issue.number}
              </Mono>
            </>
          ) : null}
        </p>
      );

    case "step.start":
      return <p className="font-medium">{frame.payload.label}</p>;

    case "tool.call":
      return (
        <p className="text-muted-foreground">
          <span className="text-foreground font-medium">{frame.payload.tool}</span>{" "}
          <Mono>{frame.payload.summary}</Mono>
        </p>
      );

    case "tool.result":
      return (
        <p className={cn("text-muted-foreground", !frame.payload.ok && "text-destructive")}>
          {frame.payload.summary}
          {frame.payload.detail ? (
            <span className="text-muted-foreground/70 mt-1 block font-mono text-xs whitespace-pre-wrap">
              {frame.payload.detail}
            </span>
          ) : null}
        </p>
      );

    case "agent.message":
      return <p className="text-pretty">{frame.payload.text}</p>;

    case "artifact.write":
      return (
        <p className="text-muted-foreground">
          Wrote{" "}
          <span className="text-foreground font-medium">
            {frame.payload.section ?? frame.payload.path}
          </span>{" "}
          <span className="text-muted-foreground/70 tabular-nums">
            ({frame.payload.bytes.toLocaleString()} bytes)
          </span>
        </p>
      );

    case "usage":
      return (
        <p className="text-muted-foreground/80 tabular-nums">
          {(frame.payload.inputTokens + frame.payload.outputTokens).toLocaleString()}{" "}
          tokens · ${frame.payload.costUsd.toFixed(4)}
        </p>
      );

    case "error":
      return <p className="text-destructive">{frame.payload.message}</p>;

    case "run.end":
      return (
        <p className="text-muted-foreground">
          Finished <span className="text-foreground font-medium">{frame.payload.status}</span>{" "}
          in {formatElapsed(frame.payload.durationMs)}
        </p>
      );
  }
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{children}</code>
  );
}
