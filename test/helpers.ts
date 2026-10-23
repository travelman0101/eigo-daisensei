import { env } from "cloudflare:workers";
import { app } from "../worker/index";
import type { Env } from "../worker/env";

export const ORIGIN = "http://localhost";

export function call(path: string, init: RequestInit & { cookie?: string; env?: Partial<Env>; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
  const body = init.json !== undefined ? JSON.stringify(init.json) : init.body;
  if (body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(`${ORIGIN}${path}`, { ...init, body, headers }, { ...(env as unknown as Env), ...init.env });
}

export const post = (path: string, json: unknown, cookie?: string, e?: Partial<Env>) => call(path, { method: "POST", json, cookie, env: e });

export async function login(name: string) {
  const res = await call(`/api/auth/dev-login?name=${name}&json=1`);
  if (res.status !== 200) throw new Error(`dev-login failed: ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** A fake Workers AI binding that records every call. */
export function fakeAI(reply: (user: string, calls: number) => unknown, delayMs = 0) {
  const calls: string[] = [];
  const ai = {
    run: async (_model: string, input: { messages: { role: string; content: string }[] }) => {
      const user = input.messages.find((m) => m.role === "user")!.content;
      calls.push(user);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const out = reply(user, calls.length);
      return { response: out, usage: { neurons: 10 } };
    },
  } as unknown as Ai;
  return { ai, calls, env: { AI: ai, AI_MOCK: "0" } as Partial<Env> };
}
