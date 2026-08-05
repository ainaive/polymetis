import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The worker runs src/lib, src/db and src/worker directly under Bun, with
    // no Next.js runtime and no bundler. Anything these modules import must
    // therefore work as plain server-side TypeScript. A stray `next/headers`
    // or `react` import fails at worker startup rather than at build time,
    // which is a slow and confusing way to find out — so it is a lint error.
    files: ["src/lib/**", "src/db/**", "src/worker/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "next",
                "next/*",
                "react",
                "react/*",
                "react-dom",
                "react-dom/*",
                "server-only",
                "@/app/*",
                "@/components/*",
                // src/auth/index.ts is framework-free and may be imported;
                // session.ts pulls next/headers and server-only.
                "@/auth/session",
              ],
              message:
                "src/lib, src/db and src/worker must stay framework-free — the worker runs them directly under Bun, outside Next.js.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
