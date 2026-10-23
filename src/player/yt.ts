/** What the practice engine needs from a player. Times in ms. */
export interface PlayerLike {
  play(): void;
  pause(): void;
  seek(ms: number): void;
  /** current time; between the iframe's updates it is interpolated from the clock */
  time(): number;
  playing(): boolean;
  setRate(rate: number): void;
  rates(): number[];
  duration(): number;
  destroy(): void;
}

export type PlayerEvent = { type: "ready" } | { type: "state"; playing: boolean; state: number } | { type: "error"; code: number; message: string };

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer; PlayerState: Record<string, number> };
    onYouTubeIframeAPIReady?: () => void;
    /** E2E: use the fake player with these durations (ms) */
    __FAKE_YT__?: { durations?: Record<string, number> };
  }
}

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  setPlaybackRate(r: number): void;
  getAvailablePlaybackRates(): number[];
  getDuration(): number;
  destroy(): void;
}

export const ERROR_MESSAGES: Record<number, string> = {
  2: "動画 ID が正しくありません",
  5: "この動画はブラウザで再生できません",
  100: "動画が見つかりません（削除・非公開の可能性があります）",
  101: "この動画は埋め込み再生が許可されていません（YouTube で開いてください）",
  150: "この動画は埋め込み再生が許可されていません（YouTube で開いてください）",
  153: "この動画は埋め込み再生できませんでした",
};

let apiPromise: Promise<void> | null = null;
function loadApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  apiPromise ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      apiPromise = null;
      reject(new Error("YouTube プレイヤーを読み込めませんでした（通信を確認してください）"));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

/** Official YouTube IFrame player. The video, its ads and YouTube's own controls are shown as YouTube provides them. */
export async function createYouTube(el: HTMLElement, videoId: string, startMs: number, onEvent: (e: PlayerEvent) => void): Promise<PlayerLike> {
  if (window.__FAKE_YT__) return createFake(videoId, startMs, onEvent);
  await loadApi();
  const target = document.createElement("div");
  el.replaceChildren(target);
  // interpolation: the iframe reports time in steps; between steps we extrapolate from the clock
  let base = { t: startMs, at: performance.now(), playing: false, rate: 1 };
  let p!: YTPlayer;
  await new Promise<void>((resolve) => {
    p = new window.YT!.Player(target, {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: { playsinline: 1, rel: 0, start: Math.floor(startMs / 1000), cc_load_policy: 0, iv_load_policy: 3, origin: location.origin },
      events: {
        onReady: () => {
          resolve();
          onEvent({ type: "ready" });
        },
        onStateChange: (e: { data: number }) => {
          base = { t: p.getCurrentTime() * 1000, at: performance.now(), playing: e.data === 1, rate: base.rate };
          onEvent({ type: "state", playing: e.data === 1, state: e.data });
        },
        onError: (e: { data: number }) => onEvent({ type: "error", code: e.data, message: ERROR_MESSAGES[e.data] ?? "動画を再生できませんでした" }),
        onPlaybackRateChange: (e: { data: number }) => (base = { ...base, t: p.getCurrentTime() * 1000, at: performance.now(), rate: e.data }),
      },
    });
  });
  let lastRaw = -1;
  return {
    play: () => p.playVideo(),
    pause: () => p.pauseVideo(),
    seek: (ms) => {
      p.seekTo(Math.max(0, ms) / 1000, true);
      base = { ...base, t: ms, at: performance.now() };
      lastRaw = -1;
    },
    time: () => {
      const raw = p.getCurrentTime() * 1000;
      const now = performance.now();
      if (raw !== lastRaw) {
        lastRaw = raw;
        base = { ...base, t: raw, at: now };
      }
      return base.playing ? base.t + (now - base.at) * base.rate : base.t;
    },
    playing: () => p.getPlayerState() === 1,
    setRate: (r) => p.setPlaybackRate(r),
    rates: () => p.getAvailablePlaybackRates?.() ?? [0.5, 0.75, 1, 1.25, 1.5],
    duration: () => p.getDuration() * 1000,
    destroy: () => p.destroy(),
  };
}

/** Clock-driven stand-in for the iframe, used only by automated tests (window.__FAKE_YT__). */
function createFake(videoId: string, startMs: number, onEvent: (e: PlayerEvent) => void): PlayerLike {
  const dur = window.__FAKE_YT__?.durations?.[videoId] ?? 3_600_000;
  let t = startMs;
  let at = performance.now();
  let playing = false;
  let rate = 1;
  const now = () => (playing ? Math.min(dur, t + (performance.now() - at) * rate) : t);
  const fake = {
    play() {
      t = now();
      at = performance.now();
      playing = true;
      onEvent({ type: "state", playing: true, state: 1 });
    },
    pause() {
      t = now();
      playing = false;
      onEvent({ type: "state", playing: false, state: 2 });
    },
    seek(ms: number) {
      t = Math.max(0, Math.min(dur, ms));
      at = performance.now();
    },
    time: now,
    playing: () => playing,
    setRate(r: number) {
      t = now();
      at = performance.now();
      rate = r;
    },
    rates: () => [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
    duration: () => dur,
    destroy() {
      playing = false;
    },
  };
  (window as unknown as { __player: unknown }).__player = fake;
  setTimeout(() => onEvent({ type: "ready" }), 50);
  return fake;
}
