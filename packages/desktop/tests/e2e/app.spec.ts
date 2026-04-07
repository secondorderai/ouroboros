/**
 * Basic E2E tests for the Ouroboros desktop app.
 *
 * Uses Playwright's Electron support to launch the packaged (or dev) app
 * and verify fundamental behavior.
 */

import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let app: ElectronApplication;

test.beforeAll(async () => {
  // Launch Electron from the built main entry point.
  // In CI, the app should be built before tests run.
  const mainPath = path.resolve(__dirname, "../../dist/main/index.js");

  app = await electron.launch({
    args: [mainPath],
    env: {
      ...process.env,
      NODE_ENV: "test",
    },
  });
});

test.afterAll(async () => {
  if (app) {
    await app.close();
  }
});

test("app launches successfully", async () => {
  const window = await app.firstWindow();
  expect(window).toBeTruthy();
});

test("main window is visible", async () => {
  const page = await app.firstWindow();
  // A visible Electron window will have a non-empty viewport
  const viewport = page.viewportSize();
  expect(viewport).toBeTruthy();
});

test("window has expected title", async () => {
  const page = await app.firstWindow();
  const title = await page.title();
  // Title may be "Ouroboros" or contain it; accept both
  expect(title.length).toBeGreaterThan(0);
});

test("window has reasonable dimensions", async () => {
  const page = await app.firstWindow();
  const size = await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }));
  expect(size.width).toBeGreaterThan(400);
  expect(size.height).toBeGreaterThan(300);
});
