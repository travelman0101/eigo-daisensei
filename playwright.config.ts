import { defineConfig, devices } from "@playwright/test";

const PORT = 4174;

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: true,
  // the local Workers runtime on Windows drops requests with more parallel browsers
  workers: 2,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // phone-sized touch device on Chromium
    ...devices["Pixel 7"],
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "mobile", use: {}, grepInvert: /@desktop/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } }, grep: /@desktop/ },
  ],
  webServer: {
    // production build served by the Workers runtime, with DEV_AUTH / AI_MOCK / TRANSCRIPT_MOCK from .dev.vars
    command: `node -e "require('fs').rmSync('.wrangler/state',{recursive:true,force:true})" && npm run build && npx wrangler d1 migrations apply eigo-daisensei --local && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/api/me`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
