import { api } from "./api";
import { db, getKv, guard, setKv } from "./db";

export type SyncKind = "material" | "progress" | "vocab" | "settings";
export type SyncState = { status: "off" | "idle" | "syncing" | "error"; message?: string; lastAt?: number };

let state: SyncState = { status: "off" };
let enabled = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(s: SyncState) => void>();

const set = (s: SyncState) => {
  state = s;
  listeners.forEach((l) => l(s));
};
export const syncState = () => state;
export const onSync = (l: (s: SyncState) => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Queues a local change for the backup. Works offline; the queue is stored on the device. */
export async function markDirty(kind: SyncKind, id: string, deleted = false) {
  await guard(db().put("outbox", { key: `${kind}|${id}`, kind, id, updatedAt: Date.now(), ...(deleted ? { deleted: true } : {}) } as never));
  if (enabled) {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 2500);
  }
}

async function load(kind: SyncKind, id: string): Promise<{ json: string; updatedAt: number } | null> {
  const d = db();
  const v =
    kind === "material" ? await d.get("materials", id) : kind === "progress" ? await d.get("progress", id) : kind === "vocab" ? await d.get("vocab", id) : { value: await getKv("settings", {}), updatedAt: (await d.get("kv", "settings"))?.updatedAt ?? 0 };
  if (!v) return null;
  return { json: JSON.stringify(v), updatedAt: (v as { updatedAt?: number }).updatedAt ?? Date.now() };
}

/** Sends queued changes. Failures stay queued and are retried later. */
export async function flush(): Promise<void> {
  if (!enabled) return;
  const queue = await db().getAll("outbox");
  if (!queue.length) {
    set({ status: "idle", lastAt: Date.now() });
    return;
  }
  set({ ...state, status: "syncing" });
  try {
    for (let i = 0; i < queue.length; i += 10) {
      const part = queue.slice(i, i + 10) as (typeof queue[number] & { deleted?: boolean })[];
      const items = [];
      for (const q of part) {
        const v = q.deleted ? null : await load(q.kind as SyncKind, q.id);
        items.push(v ? { kind: q.kind, id: q.id, json: v.json, updatedAt: v.updatedAt } : { kind: q.kind, id: q.id, json: "", updatedAt: q.updatedAt, deleted: true });
      }
      await api("/api/backup", { method: "PUT", json: { items } });
      const tx = db().transaction("outbox", "readwrite");
      for (const q of part) {
        const now = await tx.store.get(q.key);
        if (now && now.updatedAt === q.updatedAt) await tx.store.delete(q.key);
      }
      await tx.done;
    }
    set({ status: "idle", lastAt: Date.now() });
  } catch (e) {
    set({ status: "error", message: `バックアップに失敗しました（${(e as Error).message}）。あとで自動で再送します` });
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 30_000);
  }
}

interface RemoteItem {
  kind: SyncKind;
  id: string;
  json: string;
  updatedAt: number;
  deleted: boolean;
}

/** Applies backup items newer than the local copy. Returns how many were written. Never calls AI. */
export async function pull(fromScratch = false): Promise<number> {
  let since = fromScratch ? 0 : await getKv<number>("lastPull", 0);
  let after: string | undefined;
  let applied = 0;
  for (;;) {
    const q = new URLSearchParams({ since: String(since) });
    if (after) q.set("after", after);
    const page = await api<{ items: RemoteItem[]; next: { since: number; after: string } | null }>(`/api/backup?${q}`);
    for (const it of page.items) applied += (await apply(it)) ? 1 : 0;
    const last = page.items.at(-1);
    if (last) since = Math.max(since, last.updatedAt);
    if (!page.next) break;
    since = page.next.since;
    after = page.next.after;
  }
  await setKv("lastPull", since);
  return applied;
}

async function apply(it: RemoteItem): Promise<boolean> {
  const d = db();
  const pending = await d.get("outbox", `${it.kind}|${it.id}`);
  if (pending && pending.updatedAt > it.updatedAt) return false;
  if (it.kind === "settings") {
    const local = await d.get("kv", "settings");
    if (local && local.updatedAt >= it.updatedAt) return false;
    if (!it.deleted) await guard(d.put("kv", { key: "settings", value: (JSON.parse(it.json) as { value: unknown }).value, updatedAt: it.updatedAt }));
    return true;
  }
  const store = it.kind === "material" ? "materials" : it.kind === "progress" ? "progress" : "vocab";
  const local = (await d.get(store, it.id)) as { updatedAt?: number } | undefined;
  if (local && (local.updatedAt ?? 0) >= it.updatedAt) return false;
  if (it.deleted) await d.delete(store, it.id);
  else await guard(d.put(store, JSON.parse(it.json)));
  return true;
}

/** Turns backup on for a signed-in account: restores an empty device, then keeps both in sync. */
export async function startSync(): Promise<{ restored: number }> {
  enabled = true;
  set({ status: "syncing" });
  try {
    const empty = (await db().count("materials")) === 0 && (await db().count("vocab")) === 0;
    const restored = await pull(empty);
    await flush();
    return { restored: empty ? restored : 0 };
  } catch (e) {
    set({ status: "error", message: `バックアップと同期できませんでした（${(e as Error).message}）` });
    return { restored: 0 };
  }
}

export function stopSync() {
  enabled = false;
  clearTimeout(timer);
  set({ status: "off" });
}

if (typeof window !== "undefined") window.addEventListener("online", () => void flush());
