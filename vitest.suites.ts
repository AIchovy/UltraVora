import { defineWorkspace } from "vitest/config";

// Two test projects, loaded via `vitest run --workspace ./vitest.suites.ts`
// (see package.json). This file is intentionally NOT named vitest.workspace.ts
// or vitest.projects.ts: vitest auto-detects BOTH of those basenames on every
// invocation, which would hijack `pnpm test:external`
// (`vitest run -c vitest.external.config.ts`). A neutral name keeps the
// workspace opt-in via --workspace only.
//
//   - "unit": everything except *.pg.test.ts — runs in parallel.
//   - "pg":   the Postgres integration tests. Each one runs
//             `DROP SCHEMA public CASCADE` + migrate in beforeAll against a real
//             local PG; run in parallel they race and wipe each other's
//             freshly-migrated schema (the original flake:
//             `relation "user" does not exist`). `singleFork` runs every
//             *.pg.test.ts file one at a time in a single process, so any number
//             of them are safe regardless of which database each one targets.
export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "unit",
      include: [
        "packages/**/test/**/*.test.ts",
        "apps/**/test/**/*.test.{ts,tsx}",
      ],
      exclude: [
        "**/node_modules/**",
        "**/*.external.test.ts",
        "**/*.pg.test.ts",
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "pg",
      include: ["apps/**/test/**/*.pg.test.ts"],
      pool: "forks",
      poolOptions: {
        forks: { singleFork: true },
      },
    },
  },
]);
