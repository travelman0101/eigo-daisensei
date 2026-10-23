import { Hono } from "hono";
import { analyze } from "./analyze";
import { auth, optionalUser, requireUser } from "./auth";
import { backup } from "./backup";
import type { AppEnv, Env } from "./env";
import { lookup } from "./lookup";
import { purgeCaches, transcripts, videos } from "./transcript";
import { dayKey } from "./usage";

export const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  // CSRF: state-changing requests must come from our own origin.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (c.req.header("origin") !== new URL(c.req.url).origin) return c.json({ error: "forbidden" }, 403);
  }
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

app.route("/api/auth", auth);
app.use("/api/me", optionalUser);
app.get("/api/me", (c) => c.json({ user: c.get("user"), auth: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) || c.env.DEV_AUTH === "1" }));

app.use("/api/video/*", optionalUser);
app.route("/api/video", videos);
app.use("/api/transcript", requireUser);
app.route("/api/transcript", transcripts);
app.use("/api/analyze/*", requireUser);
app.route("/api/analyze", analyze);
app.use("/api/lookup", optionalUser);
app.route("/api/lookup", lookup);
app.use("/api/backup", requireUser);
app.use("/api/backup/*", requireUser);
app.route("/api/backup", backup);

app.use("/api/usage", requireUser);
app.get("/api/usage", async (c) => {
  const user = c.get("user")!;
  const since = Date.now() - 30 * 24 * 3600_000;
  const rows = await c.env.DB.prepare(
    `SELECT kind, cached, COUNT(*) AS calls, SUM(units) AS units, SUM(neurons) AS neurons, SUM(ms) AS ms,
            SUM(CASE WHEN day = ? THEN 1 ELSE 0 END) AS today
     FROM usage_log WHERE user_id = ? AND created_at > ? GROUP BY kind, cached`,
  )
    .bind(dayKey(), user.id, since)
    .all();
  return c.json({ rows: rows.results });
});

app.use("/api/account", requireUser);
app.delete("/api/account", async (c) => {
  const id = c.get("user")!.id;
  // sessions and backups cascade; the usage log keeps no personal data once the user id is cleared
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM backup_items WHERE user_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    c.env.DB.prepare("UPDATE usage_log SET user_id = NULL WHERE user_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  // daily at 04:30 JST: expired caches, sessions and old usage rows
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(purgeCaches(env));
  },
} satisfies ExportedHandler<Env>;
