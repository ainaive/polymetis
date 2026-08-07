import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "@/db";
import { accounts, sessions, users, verifications } from "@/db/schema/auth";
import { env, githubConfigured } from "@/env";
import { provisionPersonalWorkspace } from "@/lib/workspaces/provision";

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  account: {
    // The GitHub access token is a repository credential, so it must not sit
    // in plaintext in the accounts table. better-auth encrypts it with the
    // auth secret; the worker decrypts it only to clone, and it never enters
    // the sandbox (ADR-0002).
    encryptOAuthTokens: true,
  },
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: githubConfigured
    ? {
        github: {
          clientId: env.GITHUB_CLIENT_ID!,
          clientSecret: env.GITHUB_CLIENT_SECRET!,
          // Sign-in scopes only. Repository access is deliberately not
          // requested here: GitHub's classic `repo` scope grants write to
          // private repositories, which contradicts v1 being read-only. M3
          // adds repo access as a separate consented step, preferring a
          // GitHub App with fine-grained `contents: read` over classic scopes.
          scope: ["read:user", "user:email"],
        },
      }
    : undefined,
  databaseHooks: {
    user: {
      create: {
        // Every account needs a workspace: runs, quota and templates all hang
        // off one, so an account without it can do nothing. Doing this here
        // rather than lazily on first use means there is exactly one place that
        // creates tenancy, and it runs for GitHub sign-ups too.
        after: async (user) => {
          await provisionPersonalWorkspace(db, {
            id: user.id,
            email: user.email,
            name: user.name,
          });
        },
      },
    },
  },
  user: {
    additionalFields: {
      locale: {
        type: "string",
        required: false,
        defaultValue: "en",
        input: false,
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;
