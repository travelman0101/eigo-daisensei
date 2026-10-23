import { Google, decodeIdToken, generateCodeVerifier, generateState } from "arctic";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { User } from "../shared/types";
import type { AppEnv } from "./env";

const SESSION_COOKIE = "eigo_session";
const OAUTH_COOKIE = "eigo_oauth";
const NEXT_COOKIE = "eigo_next";
/** Only same-site paths, so the login cannot be used to bounce to another site. */
export const safeNext = (v: string | undefined) => (v && /^\/(?![/\\])[\x21-\x7e]*$/.test(v) && v.length < 300 ? v : "/");
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const RENEW_BEFORE = 15 * 24 * 60 * 60 * 1000;

const isSecure = (c: Context) => new URL(c.req.url).protocol === "https:";

function google(c: Context<AppEnv>) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = c.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
  const redirect = new URL("/api/auth/callback", c.req.url).toString();
  return new Google(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirect);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function upsertUser(db: D1Database, sub: string, email: string, name: string, picture: string | null) {
  const row = await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture
       RETURNING id`,
    )
    .bind(crypto.randomUUID(), sub, email, name, picture, Date.now())
    .first<{ id: string }>();
  return row!.id;
}

async function startSession(c: Context<AppEnv>, userId: string) {
  const token = randomToken();
  const expires = Date.now() + SESSION_TTL;
  await c.env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, expires)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    expires: new Date(expires),
  });
}

async function sessionUser(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256(token);
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, Date.now())
    .first<User & { expires_at: number }>();
  if (!row) return null;
  if (row.expires_at - Date.now() < RENEW_BEFORE) {
    const expires = Date.now() + SESSION_TTL;
    await c.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").bind(expires, hash).run();
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: isSecure(c), sameSite: "Lax", path: "/", expires: new Date(expires) });
  }
  return { id: row.id, email: row.email, name: row.name, picture: row.picture };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await sessionUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
};

export const auth = new Hono<AppEnv>();

auth.get("/google", (c) => {
  const g = google(c);
  if (!g) return c.json({ error: "google auth is not configured" }, 503);
  const state = generateState();
  const verifier = generateCodeVerifier();
  const url = g.createAuthorizationURL(state, verifier, ["openid", "profile", "email"]);
  url.searchParams.set("prompt", "select_account");
  setCookie(c, NEXT_COOKIE, safeNext(c.req.query("next")), { httpOnly: true, secure: isSecure(c), sameSite: "Lax", path: "/api/auth", maxAge: 600 });
  setCookie(c, OAUTH_COOKIE, `${state}.${verifier}`, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/api/auth",
    maxAge: 600,
  });
  return c.redirect(url.toString(), 302);
});

auth.get("/callback", async (c) => {
  const g = google(c);
  if (!g) return c.json({ error: "google auth is not configured" }, 503);
  const [savedState, verifier] = (getCookie(c, OAUTH_COOKIE) ?? "").split(".");
  deleteCookie(c, OAUTH_COOKIE, { path: "/api/auth" });
  const { code, state } = c.req.query();
  if (!code || !state || !savedState || !verifier || state !== savedState) {
    return c.text("Invalid login request", 400);
  }
  let claims: Record<string, unknown>;
  try {
    const tokens = await g.validateAuthorizationCode(code, verifier);
    // The ID token comes straight from Google's token endpoint over TLS, so its
    // signature does not need to be re-verified (OIDC Core 3.1.3.7).
    claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
  } catch {
    return c.text("Login failed", 400);
  }
  const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const expOk = typeof claims.exp === "number" && claims.exp * 1000 > Date.now();
  if (!issOk || claims.aud !== c.env.GOOGLE_CLIENT_ID || !expOk || claims.email_verified !== true) {
    return c.text("Login failed", 400);
  }
  const email = String(claims.email ?? "");
  const userId = await upsertUser(
    c.env.DB,
    String(claims.sub),
    email,
    String(claims.name ?? email.split("@")[0]),
    typeof claims.picture === "string" ? claims.picture : null,
  );
  await startSession(c, userId);
  const next = safeNext(getCookie(c, NEXT_COOKIE));
  deleteCookie(c, NEXT_COOKIE, { path: "/api/auth" });
  return c.redirect(next, 302);
});

auth.get("/dev-login", async (c) => {
  if (c.env.DEV_AUTH !== "1") return c.json({ error: "not found" }, 404);
  const name = (c.req.query("name") ?? "dev").slice(0, 40);
  const userId = await upsertUser(c.env.DB, `dev:${name}`, `${name}@example.test`, name, null);
  await startSession(c, userId);
  return c.req.query("json") ? c.json({ ok: true }) : c.redirect("/", 302);
});

auth.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/** Sets c.get("user") when a valid session exists, without rejecting guests. */
export const optionalUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", await sessionUser(c));
  await next();
};
