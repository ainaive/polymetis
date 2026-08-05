import "server-only";

import { headers } from "next/headers";

import { auth } from "./index";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}
