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

/** The practice screen's ⚙ sheet holds the steps, one-sentence mode, display toggles, A–B and recording. */
export async function openSettings(page: Page) {
  await page.getByRole("button", { name: "詳しい設定" }).click();
  await expect(page.getByRole("dialog", { name: "練習の設定" })).toBeVisible();
  return page.getByRole("dialog", { name: "練習の設定" });
}
export async function closeSettings(page: Page) {
  await page.getByRole("dialog", { name: "練習の設定" }).getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("dialog", { name: "練習の設定" })).toHaveCount(0);
}
type FakePlayer = { time(): number; playing(): boolean; play(): void; pause(): void };
export const playerTime = (page: Page) => page.evaluate(() => (window as unknown as { __player: FakePlayer }).__player.time());
export const isPlaying = (page: Page) => page.evaluate(() => (window as unknown as { __player: FakePlayer }).__player.playing());
/** Play / pause like the keyboard shortcut (on a phone the learner taps the YouTube video itself). */
export async function togglePlay(page: Page) {
  await page.locator("body").press(" ");
}

/** A sideways swipe on the subtitles: "left" goes ahead, "right" goes back. */
export async function swipe(page: Page, dir: "left" | "right") {
  const b = (await page.locator(".gesture").boundingBox())!;
  const y = b.y + Math.min(40, b.height / 2);
  const [x0, x1] = dir === "left" ? [b.x + b.width * 0.8, b.x + b.width * 0.2] : [b.x + b.width * 0.2, b.x + b.width * 0.8];
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, y, { steps: 3 });
  await page.mouse.move(x1, y, { steps: 3 });
  await page.mouse.up();
}
/** Pick a word of the current sentence and open its meaning (the dictionary opens only when asked). */
export async function openMeaning(page: Page, nth = 0) {
  await page.locator(".now .w").nth(nth).click();
  await page.getByRole("button", { name: "意味を調べる" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
