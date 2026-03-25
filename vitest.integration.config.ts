import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: { NODE_ENV: "test" },
    include: ["tests/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
