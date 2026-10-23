import { test as base, expect, type Page } from "@playwright/test";

/** Counts API calls by path, and how many the server answered from its cache. */
export class ApiLog {
  calls: { path: string; cached?: boolean; status: number; body: string }[] = [];
  constructor(page: Page) {
    page.on("response", async (r) => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith("/api/") || r.request().method() !== "POST") return;
      let cached: boolean | undefined;
      try {
        cached = (await r.json()).cached;
      } catch {
        /* not json */
      }
      this.calls.push({ path: u.pathname, cached, status: r.status(), body: r.request().postData() ?? "" });
    });
  }
  count(path: string, cached?: boolean) {
    return this.calls.filter((c) => c.path === path && (cached === undefined || c.cached === cached)).length;
  }
  reset() {
    this.calls = [];
  }
}

export const test = base.extend<{ api: ApiLog }>({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      window.__FAKE_YT__ = { durations: { mockLong60m: 3_600_000, mockPunct01: 180_000, mockNoSubs1: 120_000, mockShort02: 120_000 } };
    });
    await use(page);
  },
  api: async ({ page }, use) => {
    await use(new ApiLog(page));
  },
});

export { expect };

let n = 0;
/** Signs in with the dev-only login (DEV_AUTH=1) as a fresh user. */
export async function login(page: Page, name = `u${Date.now()}${n++}`) {
  await page.goto(`/api/auth/dev-login?name=${name}`);
  await page.waitForURL("/");
  return name;
}

/** Imports a range through the UI and waits for the practice screen. */
export async function importRange(page: Page, videoId: string, start: string, end: string, opts: { keepEdges?: boolean } = {}) {
  await page.goto(`/import?v=${videoId}`);
  await page.getByLabel("開始").fill(start);
  await page.getByLabel("終了").fill(end);
  await page.getByLabel("終了").blur();
  const go = page.getByRole("button", { name: "この区間を教材にする" });
  await go.click();
  const widen = page.getByRole("button", { name: /文が切れないように広げる/ });
  const keep = page.getByRole("button", { name: /このまま/ });
  await expect(page.locator(".en").first().or(widen)).toBeVisible({ timeout: 30_000 });
  if (await widen.isVisible()) await (opts.keepEdges ? keep : widen).click();
  await expect(page.locator(".now")).toBeVisible({ timeout: 30_000 });
}
