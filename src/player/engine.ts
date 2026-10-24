import type { PlayerLike } from "./yt";

export interface Unit {
  start: number;
  end: number;
  /** first sentence covered by this unit */
  sentence: number;
}

export interface EngineSettings {
  mode: "listen" | "repeat" | "shadow";
  /** times each unit is played; 0 = until stopped */
  repeats: number;
  gapMode: "none" | "fixed" | "ratio";
  gapFixed: number;
  gapRatio: number;
  autoStop: boolean;
  padPre: number;
  padPost: number;
  rate: number;
}

export interface EngineState {
  phase: "idle" | "playing" | "gap";
  unit: number;
  /** finished plays of the current unit */
  rep: number;
  gapUntil: number | null;
  /** length of the current wait */
  gapMs: number;
  ab: { a: number; b: number } | null;
  /** the current sentence repeats seamlessly until switched off (flow mode's 🔁) */
  loop: boolean;
  /** the range (whole material) is playing straight through */
  continuous: boolean;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as number),
};

/** Stop this early so the pause lands on the boundary rather than after it (the iframe reacts late). */
const STOP_LEAD = 40;

/**
 * Drives the player for practice: plays a unit, stops or loops at its end, waits, repeats and moves on.
 * `tick()` must be called often (the UI calls it every animation frame); near a boundary a timer
 * fires the stop at the exact moment instead of waiting for the next tick.
 */
export class Engine {
  state: EngineState = { phase: "idle", unit: 0, rep: 0, gapUntil: null, gapMs: 0, ab: null, loop: false, continuous: false };
  private timer: unknown = null;
  private stopTimer: unknown = null;
  /**
   * Flow mode: play straight through the range. The highlight follows the time; nothing stops,
   * repeats or waits, and moving to another sentence keeps playing from there.
   */
  private flow = false;
  /** what the engine last asked the player to do, so the player echoing it back is not taken for a tap on the video */
  private commanded: { playing: boolean; at: number } | null = null;

  private play() {
    this.commanded = { playing: true, at: this.clock.now() };
    this.player.play();
  }
  private rewoundAt = -Infinity;
  private pausePlayer() {
    this.commanded = { playing: false, at: this.clock.now() };
    this.player.pause();
  }

  constructor(
    private player: PlayerLike,
    private units: Unit[],
    private settings: EngineSettings,
    private range: { start: number; end: number },
    private onChange: (s: EngineState) => void,
    private clock: Clock = realClock,
  ) {
    player.setRate(settings.rate);
  }

  setUnits(units: Unit[], keepSentence?: number) {
    this.units = units;
    const i = keepSentence == null ? 0 : Math.max(0, units.findIndex((u, k) => u.sentence >= keepSentence || k === units.length - 1));
    this.set({ unit: Math.min(i, Math.max(0, units.length - 1)), rep: 0 });
  }

  setFlow(on: boolean) {
    this.flow = on;
    // a pending stop, repeat or wait from one-sentence practice must not fire after switching
    this.clearTimers();
    if (this.state.phase === "gap") {
      this.pausePlayer();
      this.set({ phase: "idle", gapUntil: null });
    }
    this.set({ continuous: on, rep: 0 });
  }

  isFlow() {
    return this.flow;
  }

  setSettings(s: EngineSettings) {
    if (s.rate !== this.settings.rate) this.player.setRate(s.rate);
    this.settings = s;
  }

  private set(p: Partial<EngineState>) {
    this.state = { ...this.state, ...p };
    this.onChange(this.state);
  }

  private clearTimers() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    if (this.stopTimer) this.clock.clearTimeout(this.stopTimer);
    this.timer = this.stopTimer = null;
  }

  private gapFor(u: Unit) {
    const s = this.settings;
    if (s.gapMode === "none") return 0;
    if (s.gapMode === "fixed") return s.gapFixed * 1000;
    return ((u.end - u.start) / s.rate) * s.gapRatio;
  }

  private startOf(u: Unit) {
    return Math.max(this.range.start - this.settings.padPre, u.start - this.settings.padPre, 0);
  }

  /** Plays unit i from its start. */
  playUnit(i: number, keepRep = false) {
    const u = this.units[i];
    if (!u) return;
    this.clearTimers();
    this.player.seek(this.startOf(u));
    this.play();
    this.set({ phase: "playing", unit: i, rep: keepRep ? this.state.rep : 0, gapUntil: null, continuous: this.flow });
  }

  /** Plays the whole range straight through from the given unit (or the start). */
  playRange(from = 0) {
    this.playUnit(from);
    this.set({ continuous: true });
  }

  pause() {
    this.clearTimers();
    this.pausePlayer();
    this.set({ phase: "idle", gapUntil: null });
  }

  toggle() {
    if (this.state.phase === "idle" && this.flow) {
      // resume exactly where it paused; only outside the range does it jump to a sentence start
      const t = this.player.time();
      if (t >= this.range.start - 1000 && t < this.range.end - 200) {
        this.play();
        this.set({ phase: "playing", unit: this.unitAt(t), continuous: true });
      } else this.playUnit(t >= this.range.end - 200 ? 0 : this.unitAt(t));
      return;
    }
    if (this.state.phase === "idle") {
      // resume where the video is if it is still inside the unit, otherwise start the unit again
      const u = this.units[this.state.unit];
      const t = this.player.time();
      if (u && t >= u.start - 500 && t < u.end - 200) {
        this.play();
        this.set({ phase: "playing" });
      } else this.playUnit(this.state.unit);
    } else this.pause();
  }

  /** In flow mode the current unit is the one being heard, not the last one started (unless it is looping). */
  private current() {
    return this.flow && !this.state.loop ? this.unitAt(this.player.time()) : this.state.unit;
  }

  /** Repeat the sentence being heard without stopping; switching off lets the flow continue from there. */
  setLoop(on: boolean) {
    const unit = this.flow && !this.state.loop ? this.unitAt(this.player.time()) : this.state.unit;
    this.clearTimers();
    this.set({ loop: on, unit, rep: 0 });
  }

  /**
   * Jump by ms (the ±N seconds double tap), staying inside the range (inside A–B while it loops)
   * and keeping the play state. Returns how far it really moved, which is less at an edge.
   */
  seekBy(ms: number): number {
    const now = this.player.time();
    const { ab } = this.state;
    const lo = ab ? ab.a : this.range.start - this.settings.padPre;
    const hi = ab ? Math.max(ab.a, ab.b - 300) : this.range.end;
    const t = Math.max(lo, Math.min(hi, now + ms));
    this.clearTimers();
    this.player.seek(t);
    this.set({ unit: this.unitAt(t), rep: 0 });
    return t - now;
  }

  /**
   * The video itself ended (the range reaches the end of the video). Go back to the start of the
   * range, paused, so the next play starts the practice again.
   */
  ended() {
    this.clearTimers();
    // YouTube starts playing again when an ended video is sought: keep it paused for a moment
    this.rewoundAt = this.clock.now();
    this.player.seek(this.range.start - this.settings.padPre);
    this.pausePlayer();
    this.set({ phase: "idle", unit: 0, rep: 0, gapUntil: null, continuous: this.flow });
  }

  /**
   * The learner played or paused with YouTube's own controls (tapping the video). The engine
   * follows instead of fighting it; a tap during a repetition wait means "again now".
   */
  external(playing: boolean) {
    if (playing && this.clock.now() - this.rewoundAt < 2000) return this.player.pause();
    const c = this.commanded;
    if (c && c.playing === playing && this.clock.now() - c.at < 1500) return;
    if (playing && this.state.phase === "gap") return this.skipGap();
    if (playing && this.state.phase === "idle") {
      this.clearTimers();
      const t = this.player.time();
      this.set({ phase: "playing", gapUntil: null, continuous: this.flow, ...(this.flow && !this.state.loop ? { unit: this.unitAt(t) } : {}) });
    } else if (!playing && this.state.phase === "playing") {
      this.clearTimers();
      this.set({ phase: "idle", gapUntil: null });
    }
  }

  next() {
    const cur = this.current();
    if (cur < this.units.length - 1) this.playUnit(cur + 1);
  }
  prev() {
    this.playUnit(Math.max(0, this.current() - 1));
  }
  restart() {
    this.playUnit(this.current());
  }
  /** Back to the first sentence of the range. */
  toStart() {
    this.playUnit(0);
  }

  setAB(a: number, b: number) {
    if (b - a < 300) return;
    this.set({ ab: { a, b } });
    this.clearTimers();
    this.player.seek(a);
    this.play();
    this.set({ phase: "playing", rep: 0 });
  }
  clearAB() {
    // flow continues from where the loop is now; one-sentence practice keeps its unit.
    // A stop already scheduled for the loop end must not fire after the loop is gone.
    this.clearTimers();
    this.set({ ab: null, unit: this.flow ? this.unitAt(this.player.time()) : this.state.unit });
  }

  /** Index of the unit at time t (for highlighting during continuous play). */
  unitAt(t: number) {
    // the next sentence takes over at its start (not before), so the highlight never runs ahead
    let lo = 0;
    for (let i = 0; i < this.units.length; i++) if (this.units[i]!.start <= t) lo = i;
    return lo;
  }

  tick() {
    if (this.state.phase !== "playing") return;
    const t = this.player.time();
    const { ab } = this.state;
    const u = this.units[this.state.unit];
    if (!u) return;
    const flowing = this.flow || this.state.continuous || (this.settings.mode === "listen" && !this.settings.autoStop);
    let end: number;
    if (ab) end = ab.b;
    else if (this.state.loop) end = Math.min(u.end + this.settings.padPost, this.range.end + this.settings.padPost);
    else if (flowing) {
      const at = this.unitAt(t);
      if (at !== this.state.unit && t < this.range.end) this.set({ unit: at });
      end = this.range.end + this.settings.padPost;
    } else end = Math.min(u.end + this.settings.padPost, this.range.end + this.settings.padPost);
    const left = (end - t) / this.settings.rate;
    if (left <= STOP_LEAD) this.atEnd();
    else if (left < 250 && !this.stopTimer) {
      this.stopTimer = this.clock.setTimeout(() => {
        this.stopTimer = null;
        if (this.state.phase === "playing") this.atEnd();
      }, left - STOP_LEAD);
    }
  }

  private atEnd() {
    if (this.stopTimer) this.clock.clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const s = this.settings;
    const { ab, unit } = this.state;
    const u = this.units[unit]!;
    const rep = this.state.rep + 1;
    const more = s.repeats === 0 || rep < s.repeats;

    if (ab) {
      this.player.seek(ab.a);
      this.set({ rep });
      return;
    }
    if (this.state.loop) {
      // seamless: back to the start of the same sentence, no pause
      this.player.seek(this.startOf(u));
      this.set({ rep });
      return;
    }
    if (this.flow || this.state.continuous || (s.mode === "listen" && !s.autoStop)) {
      // the end of the range (a late timer from an earlier boundary does not count)
      if (this.player.time() < this.range.end - 300) return;
      this.pausePlayer();
      this.set({ phase: "idle", continuous: this.flow });
      return;
    }
    if (s.mode === "listen") {
      this.pausePlayer();
      this.set({ phase: "idle", rep });
      return;
    }
    if (s.mode === "shadow") {
      // shadowing: never stop the audio; loop the unit, then flow into the next one
      if (more) {
        this.player.seek(this.startOf(u));
        this.set({ rep });
      } else if (unit < this.units.length - 1) {
        const nu = this.units[unit + 1]!;
        if (Math.abs(nu.start - u.end) > 400 || this.player.time() > nu.start + 300) this.player.seek(this.startOf(nu));
        this.set({ unit: unit + 1, rep: 0 });
      } else {
        this.pausePlayer();
        this.set({ phase: "idle", rep });
      }
      return;
    }
    // repetition: stop, give time to say it, then again or the next unit
    this.pausePlayer();
    const gap = this.gapFor(u);
    const go = () => {
      this.timer = null;
      if (more) this.playUnit(unit, true);
      else if (unit < this.units.length - 1) this.playUnit(unit + 1);
      else this.set({ phase: "idle", gapUntil: null, rep: 0 });
    };
    if (!more && unit >= this.units.length - 1) {
      this.set({ phase: "idle", rep, gapUntil: null });
      return;
    }
    this.set({ phase: "gap", rep, gapUntil: this.clock.now() + gap, gapMs: gap });
    this.timer = this.clock.setTimeout(go, gap);
  }

  /** Skips the remaining wait. */
  skipGap() {
    if (this.state.phase !== "gap") return;
    const { unit, rep } = this.state;
    this.clearTimers();
    const more = this.settings.repeats === 0 || rep < this.settings.repeats;
    if (more) this.playUnit(unit, true);
    else this.next();
  }

  destroy() {
    this.clearTimers();
  }
}

/** Units for the chosen granularity. Chunk times come from the (estimated) word times. */
export function buildUnits(
  sentences: { start: number; end: number; words: { start: number; end: number }[]; chunks: number[] }[],
  unit: "chunk" | "sentence" | "multi",
  multiCount: number,
  adjust: (i: number) => { s: number; e: number },
): Unit[] {
  const timed = sentences.map((s, i) => ({ ...s, start: s.start + adjust(i).s, end: s.end + adjust(i).e }));
  if (unit === "sentence") return timed.map((s, i) => ({ start: s.start, end: s.end, sentence: i }));
  if (unit === "multi") {
    const out: Unit[] = [];
    for (let i = 0; i < timed.length; i += multiCount) {
      const g = timed.slice(i, i + multiCount);
      out.push({ start: g[0]!.start, end: g.at(-1)!.end, sentence: i });
    }
    return out;
  }
  const out: Unit[] = [];
  timed.forEach((s, i) => {
    const starts = s.chunks.length ? s.chunks : [0];
    starts.forEach((c, k) => {
      const last = (starts[k + 1] ?? s.words.length) - 1;
      const first = s.words[c];
      const lw = s.words[last];
      if (!first || !lw) return;
      out.push({ start: k === 0 ? s.start : first.start, end: k === starts.length - 1 ? s.end : lw.end, sentence: i });
    });
  });
  return out;
}
