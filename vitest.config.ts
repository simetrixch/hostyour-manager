import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "shared/**/*.test.ts", "gate-runner/**/*.test.ts", "web/**/*.test.ts"],
    environment: "node",
    reporters: "default",
  },
});
