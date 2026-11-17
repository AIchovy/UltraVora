import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/test/**/*.external.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
  },
});
