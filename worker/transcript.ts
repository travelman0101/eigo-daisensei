import { Hono } from "hono";
import { transcriptHash } from "../shared/material";
import type { Segment, Transcript } from "../shared/types";
import type { AppEnv, Env } from "./env";
import { mockTranscript } from "./mockTranscripts";
import { limitReached, logUsage, usedToday } from "./usage";

const ID = /^[A-Za-z0-9_-]{11}$/;
const CACHE_TTL = 30 * 24 * 3600_000;
const MISS_TTL = 24 * 3600_000;
const SUPADATA = "https://api.supadata.ai/v1/transcript";

type Fetched =
  | { kind: "ok"; segments: Segment[]; lang: string; availableLangs: string[] }
  | { kind: "pending"; jobId: string }
  | { kind: "error"; status: number; error: string; message: string; cacheMiss?: boolean };

const MESSAGES = {
  no_transcript: "この動画には英語の字幕がありません。字幕ファイル（SRT/VTT）か、YouTube の「文字起こし」を貼り付けて取り込めます",
  no_english: "この動画には英語の字幕がありません（ほかの言語の字幕のみ）",
  video_not_found: "動画が見つかりません（非公開・削除済みの可能性があります）",
  provider_limit: "字幕サービスの今月の利用上限に達しました。字幕ファイルの読み込みは使えます",
  provider_config: "字幕サービスの設定に問題があります。字幕ファイルの読み込みは使えます",
  provider_error: "字幕サービスが応答しませんでした。しばらくして再試行してください",
} as const;

const err = (status: number, error: keyof typeof MESSAGES, cacheMiss = false): Fetched => ({ kind: "error", status, error, message: MESSAGES[error], cacheMiss });

interface SupadataBody {
  content?: { text: string; offset: number; duration: number; lang?: string }[];
  lang?: string;
  availableLangs?: string[];
  jobId?: string;
  status?: string;
  error?: string;
}

function toSegments(body: SupadataBody): Segment[] {
  return (body.content ?? [])
    .map((c) => ({ text: String(c.text ?? "").trim(), start: Math.max(0, Math.round(Number(c.offset))), dur: Math.max(0, Math.round(Number(c.duration))) }))
    .filter((s) => s.text && Number.isFinite(s.start) && Number.isFinite(s.dur))
    .sort((a, b) => a.start - b.start);
}

function fromBody(body: SupadataBody, wantLang: string): Fetched {
  const segments = toSegments(body);
  if (!segments.length) return err(404, "no_transcript", true);
  const lang = body.lang ?? wantLang;
  if (!lang.toLowerCase().startsWith(wantLang)) return err(404, "no_english", true);
  return { kind: "ok", segments, lang: wantLang, availableLangs: body.availableLangs ?? [] };
}

async function fromStatus(res: Response, wantLang: string): Promise<Fetched> {
  const body = (await res.json().catch(() => ({}))) as SupadataBody;
  if (res.status === 200) {
    if (body.status && body.status !== "completed") {
      if (body.status === "failed") return err(404, "no_transcript", true);
      return { kind: "pending", jobId: "" };
    }
    return fromBody(body, wantLang);
  }
  if (res.status === 202 && body.jobId) return { kind: "pending", jobId: body.jobId };
  if (res.status === 206) return err(404, "no_transcript", true);
  if (res.status === 404 || res.status === 400) return err(404, "video_not_found", true);
  if (res.status === 429 || res.status === 402) return err(503, "provider_limit");
  if (res.status === 401 || res.status === 403) return err(503, "provider_config");
  return err(502, "provider_error");
}

async function supadata(env: Env, path: string): Promise<Response> {
  return fetch(`${SUPADATA}${path}`, { headers: { "x-api-key": env.SUPADATA_API_KEY ?? "" } });
}

async function startFetch(env: Env, videoId: string, lang: string): Promise<Fetched> {
  if (env.TRANSCRIPT_MOCK === "1") {
    const m = mockTranscript(videoId);
    return m ? { kind: "ok", segments: m.segments, lang: m.lang, availableLangs: ["en"] } : err(404, "no_transcript", true);
  }
  if (!env.SUPADATA_API_KEY) return err(503, "provider_config");
  // mode=native: only captions that already exist on YouTube (AI-generated transcripts cost more credits)
  const q = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${videoId}`, lang, mode: "native" });
  return fromStatus(await supadata(env, `?${q}`), lang);
}

async function pollJob(env: Env, jobId: string, lang: string, waitMs: number): Promise<Fetched> {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await fromStatus(await supadata(env, `/${encodeURIComponent(jobId)}`), lang);
    if (r.kind !== "pending") return r;
    if (Date.now() > until) return { kind: "pending", jobId };
    await new Promise((res) => setTimeout(res, 1500));
  }
}

async function cached(db: D1Database, videoId: string, lang: string): Promise<Transcript | null> {
  const row = await db
    .prepare("SELECT hash, source, segments, available_langs FROM transcripts WHERE video_id = ? AND lang = ? AND expires_at > ?")
    .bind(videoId, lang, Date.now())
    .first<{ hash: string; source: string; segments: string; available_langs: string }>();
  if (!row) return null;
  return { videoId, lang, hash: row.hash, source: row.source as Transcript["source"], segments: JSON.parse(row.segments), availableLangs: JSON.parse(row.available_langs) };
}

export const transcripts = new Hono<AppEnv>();

transcripts.post("/", async (c) => {
  const body = await c.req.json<{ videoId?: string; lang?: string }>().catch(() => ({}) as { videoId?: string; lang?: string });
  const videoId = String(body.videoId ?? "");
  const lang = "en";
  if (!ID.test(videoId)) return c.json({ error: "invalid", message: "動画 ID が正しくありません" }, 400);
  const db = c.env.DB;

  const hit = await cached(db, videoId, lang);
  if (hit) {
    await logUsage(c, { kind: "transcript", cached: true });
    return c.json({ transcript: hit, cached: true });
  }
  const miss = await db.prepare("SELECT reason FROM transcript_misses WHERE video_id = ? AND expires_at > ?").bind(videoId, Date.now()).first<{ reason: keyof typeof MESSAGES }>();
  if (miss) return c.json({ error: miss.reason, message: MESSAGES[miss.reason] ?? MESSAGES.no_transcript }, 404);

  const job = await db.prepare("SELECT job_id FROM transcript_jobs WHERE video_id = ? AND created_at > ?").bind(videoId, Date.now() - 10 * 60_000).first<{ job_id: string }>();
  let result: Fetched;
  const t0 = Date.now();
  if (job) {
    result = await pollJob(c.env, job.job_id, lang, 12_000);
  } else {
    if ((await usedToday(c, ["transcript"])) >= Number(c.env.LIMIT_TRANSCRIPTS_PER_DAY)) return limitReached(c, "字幕取得");
    result = await startFetch(c.env, videoId, lang);
    await logUsage(c, { kind: "transcript", model: c.env.TRANSCRIPT_MOCK === "1" ? "mock" : "supadata", units: 1, ms: Date.now() - t0, cached: false });
    if (result.kind === "pending" && result.jobId) {
      await db.prepare("INSERT INTO transcript_jobs (video_id, job_id, lang, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET job_id = excluded.job_id, created_at = excluded.created_at")
        .bind(videoId, result.jobId, lang, Date.now())
        .run();
      result = await pollJob(c.env, result.jobId, lang, 12_000);
    }
  }

  if (result.kind === "pending") return c.json({ pending: true }, 202);
  await db.prepare("DELETE FROM transcript_jobs WHERE video_id = ?").bind(videoId).run();
  if (result.kind === "error") {
    if (result.cacheMiss)
      await db.prepare("INSERT INTO transcript_misses (video_id, reason, expires_at) VALUES (?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at")
        .bind(videoId, result.error, Date.now() + MISS_TTL)
        .run();
    return c.json({ error: result.error, message: result.message }, result.status as 404);
  }
  const hash = await transcriptHash(result.segments);
  const transcript: Transcript = { videoId, lang, hash, source: "supadata", segments: result.segments, availableLangs: result.availableLangs };
  await db
    .prepare(
      `INSERT INTO transcripts (video_id, lang, hash, source, segments, available_langs, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id, lang) DO UPDATE SET hash = excluded.hash, segments = excluded.segments, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    )
    .bind(videoId, lang, hash, "supadata", JSON.stringify(result.segments), JSON.stringify(result.availableLangs), Date.now(), Date.now() + CACHE_TTL)
    .run();
  return c.json({ transcript, cached: false });
});

/** Title and author through YouTube's public oEmbed endpoint (also tells whether embedding is allowed). */
export const videos = new Hono<AppEnv>();

videos.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID.test(id)) return c.json({ error: "invalid" }, 400);
  if (c.env.TRANSCRIPT_MOCK === "1" && id.startsWith("mock")) return c.json({ title: `テスト動画 ${id}`, author: "Mock" });
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
  if (r.status === 401 || r.status === 403) return c.json({ error: "not_embeddable", message: "この動画は埋め込み再生が許可されていません" }, 403);
  if (!r.ok) return c.json({ error: "unavailable", message: "動画が見つかりません（非公開・削除済み・URL の誤りの可能性があります）" }, 404);
  const j = (await r.json()) as { title?: string; author_name?: string };
  c.header("Cache-Control", "public, max-age=86400");
  return c.json({ title: String(j.title ?? ""), author: String(j.author_name ?? "") });
});

/** Daily cleanup of the shared caches. */
export async function purgeCaches(env: Env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM transcripts WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM transcript_misses WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM transcript_jobs WHERE created_at < ?").bind(now - 3600_000),
    env.DB.prepare("DELETE FROM ai_inflight WHERE created_at < ?").bind(now - 3600_000),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM usage_log WHERE created_at < ?").bind(now - 90 * 24 * 3600_000),
  ]);
}
