/** The ±N seconds moved by a double tap on the subtitles, chosen per video. */

export const SEEK_DEFAULT = 5;
export const SEEK_PRESETS = [3, 5, 10] as const;
export const SEEK_MIN = 1;
export const SEEK_MAX = 60;

/** The seconds for a video: the learner's saved choice for it, otherwise the default (5). */
export function seekSecondsFor(byVideo: Record<string, number> | undefined, videoId: string): { seconds: number; saved: boolean } {
  const v = byVideo?.[videoId];
  return typeof v === "number" && v >= SEEK_MIN && v <= SEEK_MAX ? { seconds: v, saved: true } : { seconds: SEEK_DEFAULT, saved: false };
}

/**
 * Checks a typed number of seconds. Full-width digits from a Japanese keyboard are accepted;
 * the value is rounded to 0.1 s. Returns the seconds or a message saying what to fix.
 */
export function parseSeekInput(text: string): { ok: true; seconds: number } | { ok: false; message: string } {
  const s = text.normalize("NFKC").trim().replace(/秒$/, "").trim();
  if (!s) return { ok: false, message: "秒数を入力してください" };
  if (!/^[+-]?\d*\.?\d+$/.test(s)) return { ok: false, message: "数字で入力してください（例: 4 や 7.5）" };
  const n = Math.round(Number(s) * 10) / 10;
  if (n <= 0) return { ok: false, message: "0 より大きい秒数を入力してください" };
  if (n < SEEK_MIN) return { ok: false, message: `${SEEK_MIN} 秒以上にしてください` };
  if (n > SEEK_MAX) return { ok: false, message: `${SEEK_MAX} 秒以下にしてください（大きく動くときは前の文・次の文が便利です）` };
  return { ok: true, seconds: n };
}

/** "5" / "7.5" — seconds for labels, without a trailing ".0". */
export const formatSeconds = (s: number) => String(Math.round(s * 10) / 10);

/**
 * One-time move from the old common setting to per-video settings: an old value other than the
 * default is kept for the videos already practised on this device; new videos start at 5.
 */
export function migrateSeek(legacy: unknown, byVideo: Record<string, number>, practisedVideos: string[]): Record<string, number> | null {
  if (typeof legacy !== "number" || legacy === SEEK_DEFAULT || legacy < SEEK_MIN || legacy > SEEK_MAX) return null;
  const next = { ...byVideo };
  for (const v of practisedVideos) if (next[v] === undefined) next[v] = legacy;
  return next;
}
