import { defineConfig } from "vitest/config";

// Live smoke tests: spawn real agent CLIs, cost real tokens. Run explicitly with `npm run smoke`.
export default defineConfig({
  test: {
    include: ["smoke/**/*.test.ts"],
    testTimeout: 180_000,
  },
});
