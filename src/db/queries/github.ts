import { eq } from "drizzle-orm";

import type { DbClient } from "@/db";
import { githubInstallations } from "@/db/schema";

/** The installation a workspace's runs may read repositories through. */
export async function installationForWorkspace(
  db: DbClient,
  workspaceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.workspaceId, workspaceId))
    .limit(1);

  return row?.installationId ?? null;
}
