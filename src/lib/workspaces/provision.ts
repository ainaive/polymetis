import { and, eq } from "drizzle-orm";

import type { Db } from "@/db";
import { workspaceMembers, workspaces } from "@/db/schema";
import { newId } from "@/lib/ids";

/**
 * Every account gets a workspace at sign-up.
 *
 * The tenancy tables have existed since M1 and nothing has ever written to
 * them. Runs, quota and templates all hang off a workspace, so an account
 * without one is an account that can do nothing — and backfilling ownership
 * later means guessing at it.
 */

/**
 * A readable, unique slug.
 *
 * Readable because it will appear in URLs, and unique because it is suffixed
 * with part of the user id: two people called "alex" must not collide, and a
 * retry loop against the unique constraint is a race waiting to be lost.
 */
export function workspaceSlug(input: { name?: string | null; email: string; id: string }): string {
  const base = (input.name?.trim() || input.email.split("@")[0] || "workspace")
    .toLowerCase()
    .normalize("NFKD")
    // Drop anything that is not a plain letter, digit or separator, so an
    // accented or non-Latin name still yields something URL-safe.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  const suffix = input.id.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toLowerCase();
  return base ? `${base}-${suffix}` : `workspace-${suffix}`;
}

/** The workspace name shown in the UI. Falls back to the email local part. */
export function workspaceName(input: { name?: string | null; email: string }): string {
  const person = input.name?.trim() || input.email.split("@")[0] || "Personal";
  return `${person}'s workspace`;
}

/**
 * Create the account's personal workspace, once.
 *
 * Idempotent: better-auth can call its create hook again on a retried sign-up,
 * and a second workspace would silently split a person's runs across two
 * tenants with no way to tell which is theirs.
 */
export async function provisionPersonalWorkspace(
  db: Db,
  user: { id: string; email: string; name?: string | null },
): Promise<{ workspaceId: string; created: boolean }> {
  const existing = await ownerWorkspace(db, user.id);
  if (existing) return { workspaceId: existing, created: false };

  try {
    return await db.transaction(async (tx) => {
      const workspaceId = newId("ws");
      await tx.insert(workspaces).values({
        id: workspaceId,
        slug: workspaceSlug(user),
        name: workspaceName(user),
      });
      await tx.insert(workspaceMembers).values({
        id: newId("wsm"),
        workspaceId,
        userId: user.id,
        role: "owner",
      });
      return { workspaceId, created: true };
    });
  } catch (error) {
    // Checking then inserting is a read-then-write race: two concurrent calls
    // can both find no membership. The unique constraint on (userId, role) is
    // what actually decides, so the loser reads the winner's workspace rather
    // than failing a sign-up over a race it was designed to tolerate.
    const raced = await ownerWorkspace(db, user.id);
    if (raced) return { workspaceId: raced, created: false };
    throw error;
  }
}

async function ownerWorkspace(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "owner")))
    .limit(1);

  return row?.workspaceId ?? null;
}

/** The workspace a viewer acts in. One per person in v1; the schema allows more. */
export async function workspaceForUser(
  db: Db,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);

  return row?.workspaceId ?? null;
}

/**
 * The viewer's workspace, creating it if it is somehow missing.
 *
 * The sign-up hook is the normal path, but it is not the only history an
 * account can have: anyone who signed up before the hook existed has none, and
 * a hook that failed once would otherwise leave an account permanently unable
 * to do anything. Callers that need a workspace should not have to care which.
 */
export async function requireWorkspace(
  db: Db,
  user: { id: string; email: string; name?: string | null },
): Promise<string> {
  const existing = await workspaceForUser(db, user.id);
  if (existing) return existing;

  const { workspaceId } = await provisionPersonalWorkspace(db, user);
  return workspaceId;
}
