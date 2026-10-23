import type { Context } from "hono";
import type { UsageKind } from "../shared/types";
import type { AppEnv } from "./env";

/** Calendar day in Japan time, used for daily limits. */
export const dayKey = (now = Date.now()) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);

export async function ipHash(c: Context<AppEnv>) {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`eigo-ip|${ip}`));
  return [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface UsageEntry {
  kind: UsageKind;
  model?: string;
  units?: number;
  neurons?: number;
  ms?: number;
  cached: boolean;
}

export async function logUsage(c: Context<AppEnv>, e: UsageEntry) {
  const user = c.get("user");
  await c.env.DB.prepare(
    "INSERT INTO usage_log (user_id, ip_hash, kind, model, units, neurons, ms, cached, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(user?.id ?? null, user ? null : await ipHash(c), e.kind, e.model ?? null, e.units ?? 0, e.neurons ?? 0, e.ms ?? 0, e.cached ? 1 : 0, dayKey(), Date.now())
    .run();
}

/** Uncached calls of these kinds made today by the current user (or guest IP). */
export async function usedToday(c: Context<AppEnv>, kinds: UsageKind[]) {
  const user = c.get("user");
  const marks = kinds.map(() => "?").join(",");
  const row = user
    ? await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM usage_log WHERE user_id = ? AND day = ? AND cached = 0 AND kind IN (${marks})`)
        .bind(user.id, dayKey(), ...kinds)
        .first<{ n: number }>()
    : await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM usage_log WHERE ip_hash = ? AND day = ? AND cached = 0 AND kind IN (${marks})`)
        .bind(await ipHash(c), dayKey(), ...kinds)
        .first<{ n: number }>();
  return row?.n ?? 0;
}

export const limitReached = (c: Context<AppEnv>, what: string) =>
  c.json({ error: "limit", message: `今日の${what}の上限に達しました。明日また使えます（保存済みの教材と単語テストはそのまま使えます）` }, 429);
