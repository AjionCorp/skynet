import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
      },
    },
  },
});
