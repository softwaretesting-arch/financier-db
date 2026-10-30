import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The db module needs a URL to load; tests that touch the database use TEST_DATABASE_URL (see test/api.test.ts).
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://127.0.0.1:1/not-used", LOG_LEVEL: "silent" },
    testTimeout: 20_000,
    fileParallelism: false,
  },
});
