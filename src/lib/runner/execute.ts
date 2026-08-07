import type { DbClient } from "@/db";
import { env } from "@/env";
import {
  runAgent,
  type RunAgentResult,
  type RunnableTemplate,
} from "@/lib/agent/driver";
import type { RunEventInput } from "@/lib/events/schema";
import {
  newRunToken,
  resolveProxyCredential,
  withCredentialProxy,
  type CredentialProxy,
} from "@/lib/sandbox/proxy";
import { createSandboxSpawn } from "@/lib/sandbox/spawn";
import type { ObservedUsage } from "@/lib/sandbox/usage-meter";

/**
 * One way to execute a run, for both the worker and the one-shot script.
 *
 * `withCredentialProxy` exists because a proxy that outlives its run is a
 * credential relay nobody is watching — but that guarantee is only as good as
 * the number of places that remember to use it. This module is that number: the
 * sandbox spawn, the proxy lifecycle, and the driver are wired together once.
 *
 * It deliberately does not touch the `runs` row or the queue. Executing is
 * separable from settling: a run can finish, or be reaped, or be abandoned by a
 * dying worker, and only settling knows what to write in each case.
 */

export type ExecuteRunOptions = {
  runId: string;
  /** Prepared checkout on the host, bind-mounted into the sandbox (ADR-0002). */
  workdir: string;
  template: RunnableTemplate;
  inputs: Record<string, string>;
  issue: string;
  repo?: { owner: string; name: string };
  issueRef?: { owner: string; name: string; number: number; title: string };
  abortController?: AbortController;
  onEvents?: (events: RunEventInput[], lastSeq: number) => void;
  /** Port for this run's proxy. 0 lets the OS pick, which is what concurrency needs. */
  proxyPort?: number;
  timeoutSeconds?: number;
};

export type ExecuteRunResult = RunAgentResult & {
  /**
   * What the egress proxy metered on the wire, or null when there was no proxy.
   *
   * This is the only usage figure that exists for a run that was killed before
   * the SDK reported its own: the agent's usage arrives in the final `result`
   * message, which a timed-out run never produces. Settling uses it to avoid
   * recording a run that burned two million tokens as having used none.
   */
  observed: ObservedUsage | null;
  /** True when the proxy's token ceiling tripped and started refusing requests. */
  tripped: boolean;
};

export async function executeRun(
  db: DbClient,
  options: ExecuteRunOptions,
): Promise<ExecuteRunResult> {
  const {
    runId,
    workdir,
    template,
    inputs,
    issue,
    repo,
    issueRef,
    abortController,
    onEvents,
    proxyPort = env.SANDBOX_PROXY_PORT,
    timeoutSeconds = env.RUN_TIMEOUT_SECONDS,
  } = options;

  // The sandbox is handed this instead of a credential; the proxy swaps in the
  // real one at egress, and rejects anything that cannot present it.
  const runToken = newRunToken();

  const drive = (proxy: CredentialProxy | null) =>
    runAgent(db, {
      runId,
      workdir,
      template,
      inputs,
      issue,
      ...(repo ? { repo } : {}),
      ...(issueRef ? { issueRef } : {}),
      ...(abortController ? { abortController } : {}),
      ...(onEvents ? { onEvents } : {}),
      timeoutSeconds,
      spawn: createSandboxSpawn({
        mode: env.SANDBOX_MODE,
        image: env.SANDBOX_IMAGE,
        // `none` mode has no container and no proxy: the spawn ignores both and
        // lets the agent resolve credentials the way any local tool would.
        proxyBaseUrl: proxy?.baseUrl ?? "",
        placeholderToken: runToken,
        workdir,
        network: env.SANDBOX_NETWORK,
        memory: env.SANDBOX_MEMORY,
        cpus: env.SANDBOX_CPUS,
      }),
    });

  if (env.SANDBOX_MODE !== "docker") {
    const result = await drive(null);
    return { ...result, observed: null, tripped: false };
  }

  return withCredentialProxy(
    {
      port: proxyPort,
      credential: resolveProxyCredential(env.ANTHROPIC_API_KEY),
      runToken,
      tokenCeiling: env.RUN_TOKEN_CEILING,
    },
    async (proxy) => {
      const result = await drive(proxy);
      // Read inside the callback: withCredentialProxy stops the proxy on the
      // way out, and these are the last numbers it will ever report.
      return { ...result, observed: proxy.usage(), tripped: proxy.tripped() };
    },
  );
}
