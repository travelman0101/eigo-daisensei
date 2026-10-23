export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const OFFLINE = "通信できませんでした。電波の良い場所で再試行してください";

export async function api<T>(path: string, init: RequestInit & { json?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, body, headers, credentials: "same-origin" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "offline", OFFLINE);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok && res.status !== 202) {
    const msg = data.message ?? (res.status === 401 ? "ログインが必要です" : res.status >= 500 ? "サーバーで問題が起きました。再試行してください" : "うまくいきませんでした");
    throw new ApiError(res.status, data.error ?? "error", msg);
  }
  return Object.assign(data, { _status: res.status }) as T;
}

export const post = <T>(path: string, json: unknown, signal?: AbortSignal) => api<T>(path, { method: "POST", json, signal });
