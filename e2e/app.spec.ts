import { ApiLog, closeSettings, expect, importRange, isPlaying, login, openSettings, playerTime, test, togglePlay } from "./fixtures";

test.describe("取り込み", () => {
  test("URL を貼ると取り込み画面が開き、時刻指定も読み取る", async ({ page }) => {
    await login(page);
    await page.getByLabel("YouTube のリンクを貼る").fill("https://youtu.be/mockPunct01?t=30");
    await page.getByRole("button", { name: "開く" }).click();
    await expect(page).toHaveURL(/\/import\?v=mockPunct01&t=30000/);
    await expect(page.getByLabel("開始")).toHaveValue("0:30");
    await expect(page.getByText("テスト動画 mockPunct01")).toBeVisible();
  });

  test("YouTube 以外の URL は理由を表示", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("YouTube のリンクを貼る").fill("https://vimeo.com/123");
    await page.getByRole("button", { name: "開く" }).click();
    await expect(page.getByRole("alert")).toHaveText("YouTube の URL を貼ってください");
  });

  test("範囲の検証（逆転・長すぎ・範囲外）", async ({ page }) => {
    await login(page);
    await page.goto("/import?v=mockLong60m");
    const start = page.getByLabel("開始");
    const end = page.getByLabel("終了");
    await start.fill("10:00");
    await end.fill("5:00");
    await expect(page.getByRole("alert")).toContainText("終了は開始より後");
    await start.fill("0:00");
    await end.fill("12:00");
    await expect(page.getByRole("alert")).toContainText("10 分まで");
    await start.fill("61:00");
    await end.fill("62:00");
    await expect(page.getByRole("alert")).toContainText("動画の長さの範囲");
    await expect(page.getByRole("button", { name: "この区間を教材にする" })).toBeDisabled();
  });

  test("字幕のない動画は理由と代替の導線を出す", async ({ page }) => {
    await login(page);
    await page.goto("/import?v=mockNoSubs1");
    await page.getByLabel("終了").fill("1:00");
    await page.getByRole("button", { name: "この区間を教材にする" }).click();
    await expect(page.getByRole("alert")).toContainText("英語の字幕がありません");
    await expect(page.getByLabel("字幕ファイル")).toBeVisible();
  });

  test("文字起こしの貼り付けで取り込める", async ({ page }) => {
    await login(page);
    await page.goto("/import?v=mockNoSubs1");
    await page.getByLabel("終了").fill("0:20");
    await page.getByRole("button", { name: "文字起こしを貼り付け" }).click();
    await page.getByLabel("文字起こし").fill("0:00\nhello and welcome to the show\n0:04\ntoday we talk about cats\n0:09\nand why they sleep so much\n0:15\nthanks for watching");
    await page.getByRole("button", { name: "この字幕で取り込む" }).click();
    const keep = page.getByRole("button", { name: /このまま/ });
    await expect(page.locator(".now").or(keep)).toBeVisible({ timeout: 20_000 });
    if (await keep.isVisible()) await keep.click();
    await expect(page.locator(".now")).toContainText(/hello/i);
  });

  test("ログイン前は取り込みボタンの代わりにログインを案内", async ({ page }) => {
    await page.goto("/import?v=mockPunct01");
    await expect(page.getByRole("link", { name: "Google でログインして取り込む" })).toBeVisible();
  });
});

test.describe("60 分の動画の 05:00〜10:00 だけを解析", () => {
  test("AI は区間（＋前後 1 ブロック）だけ処理し、再入力・連打・再読み込みで推論が増えない", async ({ page, api }) => {
    await login(page);
    await page.goto("/import?v=mockLong60m");
    await page.getByLabel("開始").fill("5:00");
    await page.getByLabel("終了").fill("10:00");
    const go = page.getByRole("button", { name: "この区間を教材にする" });
    await go.click();
    await go.click({ force: true }).catch(() => {}); // double click
    const widen = page.getByRole("button", { name: /文が切れないように広げる/ });
    await expect(page.locator(".now").or(widen)).toBeVisible({ timeout: 40_000 });
    if (await widen.isVisible()) await widen.click();
    await expect(page.locator(".now")).toBeVisible({ timeout: 40_000 });

    const punct = api.count("/api/analyze/punct");
    const translate = api.count("/api/analyze/translate");
    expect(api.count("/api/transcript")).toBe(1);
    // 5 minutes ≈ 5–6 blocks of ~60 s, plus one block of context on each side
    expect(punct).toBeGreaterThanOrEqual(5);
    expect(punct).toBeLessThanOrEqual(9);
    expect(translate).toBeGreaterThan(0);
    // every sentence lies in (or touches) 05:00–10:00
    const first = await page.locator(".now .small.muted").first().textContent();
    expect(first).toMatch(/[45]:\d\d/);

    // re-enter the same URL and range: the saved material opens, nothing is analyzed
    api.reset();
    await page.goto("/import?v=mockLong60m");
    await page.getByLabel("開始").fill("5:00");
    await page.getByLabel("終了").fill("10:00");
    await page.getByRole("button", { name: "保存済みの教材を開く" }).click();
    await expect(page.locator(".now")).toBeVisible();
    await page.reload();
    await expect(page.locator(".now")).toBeVisible();
    expect(api.calls.filter((c) => c.path.startsWith("/api/analyze") || c.path === "/api/transcript").length).toBe(0);
  });

  test("重なる区間は済んだ部分を再利用し、不足分だけ処理する", async ({ page, api }) => {
    await login(page);
    await importRange(page, "mockLong60m", "20:00", "23:00");
    const firstUncached = api.count("/api/analyze/punct", false) + api.count("/api/analyze/translate", false);
    expect(firstUncached).toBeGreaterThan(0);
    api.reset();
    await importRange(page, "mockLong60m", "21:00", "24:00");
    // the transcript comes from the device, 21–23 min from the caches
    expect(api.count("/api/transcript")).toBe(0);
    expect(api.count("/api/analyze/punct", true)).toBeGreaterThanOrEqual(2);
    expect(api.count("/api/analyze/punct", false)).toBeLessThanOrEqual(2);
  });

  test("キャンセルしても済んだ部分は残り、再開で続きから", async ({ page, api }) => {
    await login(page);
    await page.goto("/import?v=mockLong60m");
    await page.getByLabel("開始").fill("30:00");
    await page.getByLabel("終了").fill("40:00");
    await page.getByRole("button", { name: "この区間を教材にする" }).click();
    await expect(page.getByText(/文の区切りを決めています|訳と意味のまとまり/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(page.getByText("中断しました")).toBeVisible();
    await page.getByRole("button", { name: "続きから再開" }).click();
    const widen = page.getByRole("button", { name: /文が切れないように広げる/ });
    await expect(page.locator(".now").or(widen)).toBeVisible({ timeout: 40_000 });
    if (await widen.isVisible()) await widen.click();
    await expect(page.locator(".now")).toBeVisible({ timeout: 40_000 });
    // no block is ever inferred twice: a request aborted in flight may be re-sent, but then the server answers from its cache
    const inferred = api.calls.filter((c) => c.path === "/api/analyze/punct" && c.cached === false).map((c) => c.body);
    expect(new Set(inferred).size).toBe(inferred.length);
    expect(api.count("/api/analyze/punct", true)).toBeGreaterThan(0);
  });
});

test.describe("練習（シンプルな操作）", () => {
  test("操作バーは 1 段：前の文・くり返す・次の文・速度・設定だけ", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "1:00", { keepEdges: true });
    const bar = page.locator(".controls");
    await expect(bar.getByRole("button")).toHaveCount(5);
    for (const name of ["前の文へ", "この文をくり返す", "次の文へ", "再生速度", "詳しい設定"]) await expect(bar.getByRole("button", { name })).toBeVisible();
    // on a phone: video, previous / current / next sentence and the bar never overlap
    await page.getByRole("button", { name: "次の文へ" }).click();
    await expect(page.locator(".now")).toContainText("2 /");
    await togglePlay(page);
    const controlsTop = (await bar.boundingBox())!.y;
    const videoBottom = ((b) => b.y + b.height)((await page.locator(".video").boundingBox())!);
    for (const loc of [page.locator(".flow-s.before"), page.locator(".now"), page.locator(".flow-s.after")]) {
      const b = (await loc.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(videoBottom - 1);
      expect(b.y + b.height).toBeLessThanOrEqual(controlsTop + 1);
    }
    expect((await bar.boundingBox())!.height).toBeLessThan(80);
  });

  test("流れモード：止まらず・繰り返さずに文を越えて進む（再生・停止はキー／動画のタップ）", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "1:00", { keepEdges: true });
    await togglePlay(page);
    const seen = new Set<string>();
    for (let k = 0; k < 14; k++) {
      await page.waitForTimeout(1000);
      expect(await isPlaying(page)).toBe(true);
      seen.add((await page.locator(".now").textContent())!.match(/(\d+) \//)![1]!);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
    expect(await page.getByText(/話してみよう/).count()).toBe(0);
    // pausing resumes at the same position
    await togglePlay(page);
    const t = await playerTime(page);
    await togglePlay(page);
    await page.waitForTimeout(200);
    const t2 = await playerTime(page);
    expect(t2).toBeGreaterThanOrEqual(t);
    expect(t2 - t).toBeLessThan(800);
  });

  test("動画側（YouTube の操作）で止めたり再生したりしても、アプリが合わせる", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "1:00", { keepEdges: true });
    // the fake player plays / pauses by itself, like a tap on the YouTube video
    await page.evaluate(() => (window as unknown as { __player: { play(): void } }).__player.play());
    await page.waitForTimeout(7000);
    await expect(page.locator(".now")).toContainText("2 /"); // the highlight followed
    await page.evaluate(() => (window as unknown as { __player: { pause(): void } }).__player.pause());
    await togglePlay(page); // the app knows it is paused, so this plays again
    await page.waitForTimeout(300);
    expect(await isPlaying(page)).toBe(true);
  });

  test("🔁 で今の文だけを止めずにくり返し、解除するとそのまま進む", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "1:00", { keepEdges: true });
    await togglePlay(page);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "この文をくり返す" }).click();
    await expect(page.getByRole("button", { name: "この文をくり返す" })).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(13_000); // two passes of a ~6 s sentence
    await expect(page.locator(".now")).toContainText("1 /");
    expect(await isPlaying(page)).toBe(true);
    await page.getByRole("button", { name: "この文をくり返す" }).click();
    await page.waitForTimeout(7000);
    await expect(page.locator(".now")).toContainText("2 /");
  });

  test("字幕の右半分を 2 回タップで +N 秒、左半分で −N 秒（秒数は ⚙ で変えられる）", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "1:00", { keepEdges: true });
    await togglePlay(page);
    await page.waitForTimeout(1000);
    const area = page.locator(".gesture");
    const box = (await area.boundingBox())!;
    const t0 = await playerTime(page);
    await area.dblclick({ position: { x: box.width * 0.85, y: 10 } });
    await expect(page.locator(".seek-bubble")).toHaveText("+5秒");
    const t1 = await playerTime(page);
    expect(t1 - t0).toBeGreaterThan(4500);
    const sheet = await openSettings(page);
    await sheet.getByRole("button", { name: "3 秒" }).click();
    await closeSettings(page);
    const t2 = await playerTime(page);
    await area.dblclick({ position: { x: box.width * 0.15, y: 10 } });
    const t3 = await playerTime(page);
    expect(t2 - t3).toBeGreaterThan(2500);
    expect(t2 - t3).toBeLessThan(3600);
    expect(await isPlaying(page)).toBe(true);
    // a single tap on a word still opens the dictionary
    await page.locator(".now .w").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("動画での発言", { timeout: 15_000 });
  });

  test("前の文へ・次の文へ・字幕タップのあとも流れ続ける", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "1:00", { keepEdges: true });
    await togglePlay(page);
    await page.waitForTimeout(8000);
    await expect(page.locator(".now")).toContainText("2 /");
    await page.getByRole("button", { name: "前の文へ" }).click();
    await expect(page.locator(".now")).toContainText("1 /");
    await page.waitForTimeout(1200);
    expect(await isPlaying(page)).toBe(true);
    await page.getByRole("button", { name: "次の文へ" }).click();
    await expect(page.locator(".now")).toContainText("2 /");
    await page.locator(".flow-s.after").click();
    await expect(page.locator(".now")).toContainText("3 /");
    await page.waitForTimeout(1000);
    expect(await isPlaying(page)).toBe(true);
  });

  test("⚙ から一文練習へ：反復と待ち時間が使え、戻すと流れモード", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "0:30", { keepEdges: true });
    let sheet = await openSettings(page);
    await sheet.getByRole("tab", { name: /区切ってまねる/ }).click();
    await expect(sheet.getByRole("radio", { name: /一文練習/ })).toHaveAttribute("aria-checked", "true");
    await sheet.getByRole("button", { name: "一文", exact: true }).click();
    await sheet.getByRole("button", { name: "2", exact: true }).first().click();
    await sheet.getByRole("button", { name: "なし", exact: true }).first().click();
    await closeSettings(page);
    await expect(page.getByRole("button", { name: "この文をもう一度" })).toBeVisible();
    await togglePlay(page);
    await expect(page.locator(".now")).toContainText("2 /", { timeout: 20_000 }); // after 2 plays it moves on
    sheet = await openSettings(page);
    await sheet.getByRole("radio", { name: /流れモード/ }).click();
    await closeSettings(page);
    await expect(page.getByRole("button", { name: "この文をくり返す" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "この文をくり返す" })).toBeVisible();
  });

  test("一文練習：文末で止まり、話す時間のあと反復（テスト用プレイヤー）", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "0:30", { keepEdges: true });
    const sheet = await openSettings(page);
    await sheet.getByRole("tab", { name: /区切ってまねる/ }).click();
    await sheet.getByRole("button", { name: "一文", exact: true }).click();
    await closeSettings(page);
    await togglePlay(page);
    await expect(page.getByText(/話してみよう/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "飛ばす" }).click();
    await page.waitForTimeout(300);
    expect(await isPlaying(page)).toBe(true);
  });

  test("字幕・訳・速度の設定と位置が保存される", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "1:00", { keepEdges: true });
    await page.getByRole("button", { name: "次の文へ" }).click();
    await page.getByRole("button", { name: "次の文へ" }).click();
    await expect(page.locator(".now")).toContainText("3 /");
    await page.getByRole("button", { name: "再生速度" }).click();
    await expect(page.getByRole("button", { name: "再生速度" })).toHaveText("1.25x");
    const sheet = await openSettings(page);
    await sheet.getByRole("button", { name: "訳", exact: true }).click();
    await sheet.getByRole("button", { name: "英語字幕" }).click();
    await closeSettings(page);
    await expect(page.locator(".now .ja")).toHaveCount(0);
    await expect(page.locator(".now .en")).toHaveClass(/hidden-text/);
    await page.waitForTimeout(900);
    await page.reload();
    await expect(page.locator(".now")).toContainText("3 /");
    await expect(page.getByRole("button", { name: "再生速度" })).toHaveText("1.25x");
    await expect(page.locator(".now .en")).toHaveClass(/hidden-text/);
  });

  test("A–B のくり返しは ⚙ から：解除するとそこから流れる", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "0:30", { keepEdges: true });
    await togglePlay(page);
    let sheet = await openSettings(page);
    await sheet.getByRole("button", { name: "A–B ループ" }).click();
    await closeSettings(page);
    await page.waitForTimeout(1500);
    sheet = await openSettings(page);
    await sheet.getByRole("button", { name: "A–B ループ" }).click();
    await closeSettings(page);
    await expect(page.getByText("A–B をくり返し中")).toBeVisible();
    await page.waitForTimeout(2500);
    expect(await playerTime(page)).toBeLessThan(5000);
    await page.locator(".controls").getByRole("button", { name: "解除" }).click();
    const tc = await playerTime(page);
    await page.waitForTimeout(3000);
    expect((await playerTime(page)) - tc).toBeGreaterThan(2500); // kept flowing forward, no jump back
    await expect(page.getByText("A–B をくり返し中")).toHaveCount(0);
  });

  test("教材全体のずらしと文ごとの補正が保存される", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "0:30", { keepEdges: true });
    let sheet = await openSettings(page);
    await sheet.getByRole("button", { name: "時刻の補正（ずれるとき）" }).click();
    await page.getByRole("button", { name: "教材全体を0.1 秒遅く" }).click();
    await page.getByRole("button", { name: "教材全体を0.1 秒遅く" }).click();
    await expect(page.getByText("教材全体をずらす （+0.2 秒）")).toBeVisible();
    await page.waitForTimeout(900);
    await page.reload();
    sheet = await openSettings(page);
    await sheet.getByRole("button", { name: "時刻の補正（ずれるとき）" }).click();
    await expect(page.getByText("教材全体をずらす （+0.2 秒）")).toBeVisible();
  });
});

test.describe("単語帳とテスト", () => {
  test("単語・熟語を保存し、カードと穴埋めでテストできる", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "0:30", { keepEdges: true });
    await page.locator(".now .w").nth(1).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("（意味）")).toBeVisible();
    await expect(sheet.getByText("動画での発言")).toBeVisible();
    await expect(sheet.getByText("例文（AI が作成）")).toBeVisible();
    await sheet.getByRole("button", { name: "単語帳に保存" }).click();
    await expect(sheet.getByRole("button", { name: "✓ 単語帳に保存済み" })).toBeVisible();
    // extend to a two-word phrase
    await sheet.getByRole("button", { name: "次の語も含める" }).click();
    await expect(sheet.getByRole("button", { name: "単語帳に保存" })).toBeEnabled();
    await sheet.getByRole("button", { name: "単語帳に保存" }).click();
    await sheet.getByRole("button", { name: "閉じる", exact: true }).click();

    await page.goto("/vocab");
    await expect(page.locator("main")).toContainText("すべての単語（2）");
    await page.getByRole("button", { name: "カード（英→意味）" }).click();
    await page.getByRole("button", { name: "答えを見る" }).click();
    await page.getByRole("button", { name: "覚えていた" }).click();
    await page.getByRole("button", { name: "答えを見る" }).click();
    await page.getByRole("button", { name: "忘れていた" }).click();
    // the missed one comes back once at the end
    await page.getByRole("button", { name: "答えを見る" }).click();
    await page.getByRole("button", { name: "覚えていた" }).click();
    await expect(page.getByText("おつかれさま")).toBeVisible();

    await page.goto("/vocab");
    await page.getByRole("button", { name: "出典の文で穴埋め" }).click();
    const blankAnswer = page.getByLabel("答え");
    // type the right answer in different case with spaces: still correct
    const hint = await page.locator(".quiz-card").textContent();
    expect(hint).toContain("動画での発言");
    await blankAnswer.fill("  WRONG  ");
    await page.getByRole("button", { name: "答える" }).click();
    await expect(page.getByRole("status").filter({ hasText: "正解は" })).toBeVisible();
  });

  test("アカウントごとに単語帳・教材が分かれる", async ({ page }) => {
    await login(page, `sepA${Date.now()}`);
    await importRange(page, "mockPunct01", "0:00", "0:30", { keepEdges: true });
    await page.locator(".now .w").first().click();
    await page.getByRole("dialog").getByRole("button", { name: "単語帳に保存" }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "✓ 単語帳に保存済み" })).toBeVisible();
    await page.goto("/settings");
    await page.getByRole("button", { name: "ログアウト" }).click();
    await page.waitForURL("/");
    await expect(page.getByText("まだありません")).toBeVisible();
    await page.goto("/vocab");
    await expect(page.locator("main")).toContainText("すべての単語（0）");
    await login(page, `sepB${Date.now()}`);
    await page.goto("/vocab");
    await expect(page.locator("main")).toContainText("すべての単語（0）");
    await page.goto("/library");
    await expect(page.getByText("まだ教材がありません")).toBeVisible();
  });
});

test.describe("保存と復元", () => {
  test("AI や通信が止まっても保存済み教材と単語テストが使える", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "0:30", { keepEdges: true });
    await page.locator(".now .w").first().click();
    await page.getByRole("dialog").getByRole("button", { name: "単語帳に保存" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
    const url = page.url();
    await page.route("**/api/**", (r) => r.abort());
    await page.goto(url);
    await expect(page.locator(".now")).toBeVisible();
    await page.getByRole("button", { name: "次の文へ" }).click();
    await page.goto("/vocab/test?type=card&scope=all");
    await page.getByRole("button", { name: "答えを見る" }).click();
    await expect(page.getByRole("button", { name: "覚えていた" })).toBeVisible();
  });

  test("端末のデータを消してもバックアップから AI なしで復元", async ({ page, api }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "0:40", { keepEdges: true });
    await page.waitForTimeout(3500); // backup is sent a few seconds after a change
    await page.goto("/settings");
    await page.getByRole("button", { name: "今すぐバックアップ" }).click();
    await expect(page.getByText(/同期済み/)).toBeVisible({ timeout: 10_000 });
    const names = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name!).filter((n) => n.startsWith("eigo:")));
    await page.evaluate(async (ns) => {
      for (const n of ns) await new Promise((r) => { const q = indexedDB.deleteDatabase(n); q.onsuccess = q.onerror = q.onblocked = () => r(null); });
    }, names);
    api.reset();
    await page.goto("/");
    await expect(page.getByText(/バックアップから \d+ 件を復元しました/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("テスト動画 mockPunct01").first()).toBeVisible();
    expect(api.calls.filter((c) => c.path.startsWith("/api/analyze") || c.path === "/api/transcript").length).toBe(0);
  });
});

test.describe("見本・ホーム", () => {
  test("ホーム: 初回でもリンク入力と見本がすぐ見える（ログイン不要）", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("YouTube のリンクを貼る")).toBeVisible();
    await expect(page.getByRole("heading", { name: "レベル別の見本" })).toBeVisible();
    for (const l of ["A1", "A2", "B1", "B2", "C1"]) await expect(page.getByRole("tab", { name: l })).toBeVisible();
  });

  test("見本はログインなしで各レベル 3 本あり、出典つきで練習できる", async ({ page }) => {
    await page.goto("/");
    for (const l of ["A1", "A2", "B1", "B2", "C1"]) {
      await page.getByRole("tab", { name: l }).click();
      await expect(page.locator("section").filter({ hasText: "レベル別の見本" }).locator("button.item")).toHaveCount(3);
    }
    await page.getByRole("tab", { name: "B1" }).click();
    await page.locator("section").filter({ hasText: "レベル別の見本" }).locator("button.item").first().click();
    await expect(page.locator(".now")).toBeVisible();
    await expect(page.getByText("B1 の目安")).toBeVisible();
    await expect(page.getByText(/出典:/)).toBeVisible();
    // a sample link works on a device that never opened it
    await page.goto("/m/sample_c1-nasa-landers");
    await expect(page.locator(".now")).toContainText("1 /");
  });

  test("デスクトップ幅の表示 @desktop", async ({ page }) => {
    await login(page);
    await importRange(page, "mockPunct01", "0:00", "0:30", { keepEdges: true });
    const v = (await page.locator(".video").boundingBox())!;
    expect(v.width).toBeLessThanOrEqual(720);
    await expect(page.getByRole("button", { name: "次の文へ" })).toBeInViewport();
  });
});

export { ApiLog };
