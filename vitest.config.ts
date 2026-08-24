import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/cli.ts"], // three lines of wiring; program.ts holds the logic
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
