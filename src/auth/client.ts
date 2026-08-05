import { createAuthClient } from "better-auth/react";

// No baseURL: better-auth's client falls back to the relative path
// "/api/auth", which the browser resolves against window.location.origin. That
// keeps the client working on preview deploys and any custom host without
// needing a public URL env var to be set correctly.
export const authClient = createAuthClient();

export type { Session } from "./index";
