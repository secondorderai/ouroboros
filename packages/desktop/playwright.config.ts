import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: 1,
  // File-level parallelism. Each spec file launches its own Electron
  // instance; tests within a file share a module-level `launched` and an
  // `afterEach` cleanup, so they must stay sequential within the file
  // (no `fullyParallel`). On the 2-vCPU GHA free-tier runner Electron is
  // mostly I/O-bound waiting on IPC, so 4 workers oversubscribes
  // productively — the gain from overlapping app boots dwarfs CPU
  // contention.
  workers: process.env.CI ? 4 : 1,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "electron",
      testMatch: "**/*.spec.ts",
    },
  ],
});
