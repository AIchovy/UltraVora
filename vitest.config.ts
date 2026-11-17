import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Shared base config, extended by the projects in vitest.suites.ts (which the
// `test` / `test:watch` scripts load via `--workspace`). `include` is omitted
// here on purpose: workspace `extends` MERGES include arrays, so a base include
// would leak into every project (e.g. the "pg" project would then match all
// *.test.ts files). Each project declares its own include.
export default defineConfig({
  resolve: {
    alias: {
      "@/": fileURLToPath(new URL("./apps/web/src/", import.meta.url)),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    exclude: ["**/node_modules/**", "**/*.external.test.ts"],
    environment: "node",
    setupFiles: ["./apps/web/vitest.setup.ts"],
  },
});
