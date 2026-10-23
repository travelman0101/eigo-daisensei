const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export type ParsedUrl = { ok: true; videoId: string; startMs: number | null } | { ok: false; error: string };

/** "90", "90s", "1m30s", "1h2m3s" → ms */
function parseTParam(t: string | null): number | null {
  if (!t) return null;
  const s = t.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || !s) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** Normalizes any common YouTube URL (or a bare 11-character id) to its video id and start time. */
export function parseYouTubeUrl(input: string): ParsedUrl {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "URL を入力してください" };
  if (raw.length > 500) return { ok: false, error: "URL が長すぎます" };
  if (ID.test(raw)) return { ok: true, videoId: raw, startMs: null };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "URL の形式が正しくありません" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "URL の形式が正しくありません" };
  if (!HOSTS.has(url.hostname.toLowerCase())) return { ok: false, error: "YouTube の URL を貼ってください" };
  let id: string | null = null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname.toLowerCase().endsWith("youtu.be")) id = parts[0] ?? null;
  else if (parts[0] === "watch") id = url.searchParams.get("v");
  else if (["shorts", "embed", "live", "v", "e"].includes(parts[0] ?? "")) id = parts[1] ?? null;
  else if (url.searchParams.get("v")) id = url.searchParams.get("v");
  if (!id || !ID.test(id)) return { ok: false, error: "動画の ID が見つかりません（再生リストやチャンネルの URL は使えません）" };
  const hashT = url.hash.match(/t=([^&]+)/)?.[1] ?? null;
  const startMs = parseTParam(url.searchParams.get("t")) ?? parseTParam(url.searchParams.get("start")) ?? parseTParam(hashT);
  return { ok: true, videoId: id, startMs };
}

export const watchUrl = (videoId: string, startMs?: number) =>
  `https://www.youtube.com/watch?v=${videoId}${startMs ? `&t=${Math.floor(startMs / 1000)}s` : ""}`;

/** ms → "m:ss" / "h:mm:ss" (with tenths when `tenths`) */
export function formatTime(ms: number, tenths = false): string {
  const neg = ms < 0;
  const total = Math.abs(ms) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const t = Math.floor((total * 10) % 10);
  const ss = String(s).padStart(2, "0") + (tenths ? `.${t}` : "");
  return (neg ? "-" : "") + (h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`);
}

/** "5:00", "1:02:03", "300", "5:00.5", "1m30s", "５：００" → ms, or null */
export function parseTime(input: string): number | null {
  const s = input
    .trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/[．]/g, ".");
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const hms = s.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/i);
  if (hms && /[hms]/i.test(s)) return Math.round(((Number(hms[1] ?? 0) * 60 + Number(hms[2] ?? 0)) * 60 + Number(hms[3] ?? 0)) * 1000);
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.slice(0, -1).every((p) => /^\d+$/.test(p)) || !/^\d+(\.\d+)?$/.test(parts.at(-1)!)) return null;
  const nums = parts.map(Number);
  if (nums.slice(1).some((n) => n >= 60)) return null;
  const sec = nums.length === 3 ? nums[0]! * 3600 + nums[1]! * 60 + nums[2]! : nums[0]! * 60 + nums[1]!;
  return Math.round(sec * 1000);
}
