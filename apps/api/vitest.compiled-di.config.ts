import { defineConfig } from "vitest/config";

// Run through test:compiled-di, which builds the production Nest artifacts first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/compiled-di/**/*.di.ts"],
    minWorkers: 1,
    maxWorkers: 1,
  },
});
