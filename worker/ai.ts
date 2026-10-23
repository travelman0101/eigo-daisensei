import { sha256Hex } from "../shared/material";
import type { Env } from "./env";

/** Bump when a prompt changes in a way that should not reuse old cached results. */
export const PROMPT_VERSION = { punct: 1, translate: 1, lookup: 2 } as const;

export interface AiResult {
  text: string;
  neurons: number;
  ms: number;
  model: string;
}

/**
 * Runs the chat model. Caption text only ever goes into the user message and the system message
 * says it is data, so instructions inside a video's speech are not followed.
 */
export async function runModel(
  env: Env,
  system: string,
  user: string,
  opts: { json?: boolean; maxTokens?: number; mock: () => string },
): Promise<AiResult> {
  const t = Date.now();
  if (env.AI_MOCK === "1") return { text: opts.mock(), neurons: 0, ms: Date.now() - t, model: "mock" };
  const r = (await env.AI.run(env.AI_MODEL as keyof AiModels, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: opts.maxTokens ?? 2000,
    temperature: 0.1,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  } as never)) as { response?: unknown; choices?: { message?: { content?: unknown } }[]; usage?: { neurons?: number } };
  const raw = r.response ?? r.choices?.[0]?.message?.content ?? "";
  return { text: typeof raw === "string" ? raw : JSON.stringify(raw), neurons: r.usage?.neurons ?? 0, ms: Date.now() - t, model: env.AI_MODEL };
}

/** Parses the first JSON object in a model reply. */
export function parseJson<T>(text: string): T | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1)) as T;
  } catch {
    return null;
  }
}

export const cacheKey = (kind: string, version: number, model: string, input: string) => sha256Hex(`${kind}|${version}|${model}|${input}`);

export async function cacheGet<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM ai_cache WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function cachePut(db: D1Database, key: string, kind: string, value: unknown) {
  await db
    .prepare("INSERT INTO ai_cache (key, kind, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING")
    .bind(key, kind, JSON.stringify(value), Date.now())
    .run();
}

const INFLIGHT_STALE = 90_000;

/**
 * Returns the cached value for `key`, or computes it once. A second request for the same key while
 * the first is still running waits for its result instead of calling the model again.
 * `compute` returns null when the result should not be cached (invalid output).
 */
export async function once<T>(db: D1Database, key: string, kind: string, compute: () => Promise<T | null>): Promise<{ value: T | null; cached: boolean }> {
  const hit = await cacheGet<T>(db, key);
  if (hit !== null) return { value: hit, cached: true };
  const now = Date.now();
  await db.prepare("DELETE FROM ai_inflight WHERE key = ? AND created_at < ?").bind(key, now - INFLIGHT_STALE).run();
  const claim = await db.prepare("INSERT INTO ai_inflight (key, created_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(key, now).run();
  if (!claim.meta.changes) {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const v = await cacheGet<T>(db, key);
      if (v !== null) return { value: v, cached: true };
      const still = await db.prepare("SELECT 1 FROM ai_inflight WHERE key = ?").bind(key).first();
      if (!still) break;
    }
    const v = await cacheGet<T>(db, key);
    if (v !== null) return { value: v, cached: true };
    throw new Error("busy");
  }
  try {
    const value = await compute();
    if (value !== null) await cachePut(db, key, kind, value);
    return { value, cached: false };
  } finally {
    await db.prepare("DELETE FROM ai_inflight WHERE key = ?").bind(key).run();
  }
}
