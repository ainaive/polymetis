import "server-only";

import { db } from "@/db";
import type { Viewer } from "@/lib/runs/access";
import { workspaceForUser } from "@/lib/workspaces/provision";

import { getSession } from "./session";

/**
 * Who is asking, in the only terms access control cares about.
 *
 * Deliberately does not provision a workspace: reading a run must not have the
 * side effect of creating tenancy, and a viewer with none simply cannot see
 * anyone's private runs.
 */
export async function currentViewer(): Promise<Viewer> {
  const session = await getSession();
  if (!session) return { workspaceId: null };
  return { workspaceId: await workspaceForUser(db, session.user.id) };
}
