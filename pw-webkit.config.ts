import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// The same screen tests on WebKit (Safari's engine) at iPhone size. Needs `npx playwright install webkit`.
// It is an emulation on the PC, not a real iPhone.
export default defineConfig({
  ...base,
  timeout: 60_000,
  workers: 1,
  use: { ...base.use, ...devices["iPhone 13"] },
  projects: [{ name: "iphone-webkit", grepInvert: /@desktop/ }],
});
