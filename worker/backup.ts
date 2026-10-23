import { Hono } from "hono";
import type { AppEnv } from "./env";

export const BACKUP_KINDS = ["material", "progress", "vocab", "settings"] as const;
const MAX_ITEM_BYTES = 1024 * 1024;
const MAX_ITEMS_PER_PUT = 50;
const PAGE = 100;

interface Item {
  kind: string;
  id: string;
  json: string;
  updatedAt: number;
  deleted?: boolean;
}

/** Backup of on-device data. Every query is scoped to the signed-in user's id. */
export const backup = new Hono<AppEnv>();

backup.get("/", async (c) => {
  const user = c.get("user")!;
  const since = Number(c.req.query("since") ?? 0) || 0;
  const after = c.req.query("after") ?? "";
  const [kAfter, iAfter] = after ? after.split("\u0000") : ["", ""];
  const rows = await c.env.DB.prepare(
    `SELECT kind, id, json, updated_at, deleted FROM backup_items
     WHERE user_id = ? AND (updated_at > ? OR (updated_at = ? AND (kind > ? OR (kind = ? AND id > ?))))
     ORDER BY updated_at, kind, id LIMIT ?`,
  )
    .bind(user.id, since, since, kAfter ?? "", kAfter ?? "", iAfter ?? "", PAGE)
    .all<{ kind: string; id: string; json: string; updated_at: number; deleted: number }>();
  const items = rows.results.map((r) => ({ kind: r.kind, id: r.id, json: r.json, updatedAt: r.updated_at, deleted: !!r.deleted }));
  const last = items.at(-1);
  return c.json({ items, next: items.length === PAGE && last ? { since: last.updatedAt, after: `${last.kind}\u0000${last.id}` } : null });
});

backup.put("/", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ items?: Item[] }>().catch(() => ({}) as { items?: Item[] });
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > MAX_ITEMS_PER_PUT) return c.json({ error: "invalid" }, 400);
  for (const it of items) {
    if (!BACKUP_KINDS.includes(it.kind as never) || typeof it.id !== "string" || !it.id || it.id.length > 200 || typeof it.json !== "string" || !Number.isFinite(it.updatedAt))
      return c.json({ error: "invalid" }, 400);
    if (new TextEncoder().encode(it.json).length > MAX_ITEM_BYTES) return c.json({ error: "too_large", message: "1 件のデータが大きすぎてバックアップできません" }, 413);
  }
  const used = await c.env.DB.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM backup_items WHERE user_id = ?").bind(user.id).first<{ n: number }>();
  const adding = items.reduce((n, it) => n + it.json.length, 0);
  if ((used?.n ?? 0) + adding > Number(c.env.BACKUP_QUOTA_BYTES)) return c.json({ error: "quota", message: "バックアップの容量（20MB）を超えます。不要な教材を削除してください" }, 413);
  // last write wins: an older copy never overwrites a newer one
  await c.env.DB.batch(
    items.map((it) =>
      c.env.DB.prepare(
        `INSERT INTO backup_items (user_id, kind, id, json, bytes, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind, id) DO UPDATE SET json = excluded.json, bytes = excluded.bytes, updated_at = excluded.updated_at, deleted = excluded.deleted
         WHERE excluded.updated_at >= backup_items.updated_at`,
      ).bind(user.id, it.kind, it.id, it.deleted ? "" : it.json, it.deleted ? 0 : it.json.length, Math.floor(it.updatedAt), it.deleted ? 1 : 0),
    ),
  );
  return c.json({ ok: true });
});

backup.delete("/", async (c) => {
  await c.env.DB.prepare("DELETE FROM backup_items WHERE user_id = ?").bind(c.get("user")!.id).run();
  return c.json({ ok: true });
});

backup.get("/stats", async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM backup_items WHERE user_id = ? AND deleted = 0")
    .bind(c.get("user")!.id)
    .first<{ n: number; bytes: number }>();
  return c.json({ items: row?.n ?? 0, bytes: row?.bytes ?? 0, quota: Number(c.env.BACKUP_QUOTA_BYTES) });
});
