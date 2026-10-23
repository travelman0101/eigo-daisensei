import { describe, expect, it } from "vitest";
import { Engine, buildUnits, type Clock, type EngineSettings } from "../src/player/engine";
import type { PlayerLike } from "../src/player/yt";

/** Manual clock + player whose time advances with the clock. */
function rig(settings: Partial<EngineSettings> = {}) {
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + Math.max(0, ms), fn, id });
      return id;
    },
    clearTimeout: (id) => (timers = timers.filter((t) => t.id !== id)),
  };
  let t = 0;
  let playing = false;
  let rate = 1;
  const log: string[] = [];
  const player: PlayerLike = {
    play: () => ((playing = true), log.push(`play@${Math.round(t)}`)),
    pause: () => ((playing = false), log.push(`pause@${Math.round(t)}`)),
    seek: (ms) => ((t = ms), log.push(`seek@${ms}`)),
    time: () => t,
    playing: () => playing,
    setRate: (r) => (rate = r),
    rates: () => [1],
    duration: () => 600_000,
    destroy: () => {},
  };
  const s: EngineSettings = { mode: "repeat", repeats: 2, gapMode: "ratio", gapFixed: 1, gapRatio: 1, autoStop: true, padPre: 0, padPost: 0, rate: 1, ...settings };
  const units = [
    { start: 1000, end: 2000, sentence: 0 },
    { start: 2000, end: 3500, sentence: 1 },
    { start: 5000, end: 6000, sentence: 2 },
  ];
  const engine = new Engine(player, units, s, { start: 1000, end: 6000 }, () => {}, clock);
  const advance = (ms: number) => {
    for (let k = 0; k < ms; k += 10) {
      now += 10;
      if (playing) t += 10 * rate;
      for (const tm of timers.filter((x) => x.at <= now)) {
        timers = timers.filter((x) => x !== tm);
        tm.fn();
      }
      engine.tick();
    }
  };
  return { engine, advance, log, get t() { return t; } };
}

describe("engine", () => {
  it("repeats a sentence with a wait as long as the sentence, then moves on", () => {
    const r = rig();
    r.engine.playUnit(0);
    r.advance(1000); // plays 1000-2000
    expect(r.engine.state).toMatchObject({ phase: "gap", rep: 1 });
    r.advance(1000); // 1 s gap
    expect(r.engine.state).toMatchObject({ phase: "playing", unit: 0, rep: 1 });
    r.advance(1000);
    r.advance(1000);
    expect(r.engine.state).toMatchObject({ unit: 1, rep: 0, phase: "playing" });
    // stops land on the boundary (within the stop lead)
    const pauses = r.log.filter((l) => l.startsWith("pause")).map((l) => Number(l.split("@")[1]));
    expect(pauses.every((p) => Math.abs(p - 2000) <= 60)).toBe(true);
  });

  it("shadowing loops without pausing and flows into the next unit", () => {
    const r = rig({ mode: "shadow", repeats: 2 });
    r.engine.playUnit(0);
    r.advance(2100);
    expect(r.log.some((l) => l.startsWith("pause"))).toBe(false);
    expect(r.engine.state.unit).toBe(1);
  });

  it("listen + auto stop pauses at the sentence end", () => {
    const r = rig({ mode: "listen", autoStop: true });
    r.engine.playUnit(1);
    r.advance(2000);
    expect(r.engine.state.phase).toBe("idle");
    expect(Math.abs(r.t - 3500)).toBeLessThanOrEqual(60);
  });

  it("whole range plays straight through, follows the current unit and stops at the range end", () => {
    const r = rig();
    r.engine.playRange(0);
    r.advance(4500);
    expect(r.engine.state.unit).toBe(2);
    r.advance(1000);
    expect(r.engine.state.phase).toBe("idle");
    expect(Math.abs(r.t - 6000)).toBeLessThanOrEqual(60);
  });

  it("A–B loop repeats until cleared", () => {
    const r = rig();
    r.engine.setAB(1200, 1700);
    r.advance(1600);
    expect(r.engine.state.rep).toBeGreaterThanOrEqual(2);
    expect(r.log.filter((l) => l === "seek@1200").length).toBeGreaterThanOrEqual(3);
  });

  it("fixed gap, skip gap and no gap", () => {
    const r = rig({ gapMode: "fixed", gapFixed: 3 });
    r.engine.playUnit(0);
    r.advance(1000);
    expect(r.engine.state.phase).toBe("gap");
    r.engine.skipGap();
    expect(r.engine.state.phase).toBe("playing");
    const n = rig({ gapMode: "none", repeats: 1 });
    n.engine.playUnit(0);
    n.advance(1050);
    expect(n.engine.state).toMatchObject({ phase: "playing", unit: 1 });
  });

  it("respects speed for the wait", () => {
    const r = rig({ rate: 0.5 });
    r.engine.playUnit(0);
    r.advance(2000); // 1 s of video at half speed
    expect(r.engine.state.phase).toBe("gap");
    r.advance(1900);
    expect(r.engine.state.phase).toBe("gap"); // wait = 2 s (what was heard)
    r.advance(200);
    expect(r.engine.state.phase).toBe("playing");
  });
});

describe("buildUnits", () => {
  const sents = [
    { start: 0, end: 3000, words: [0, 1, 2, 3].map((k) => ({ start: k * 750, end: (k + 1) * 750 })), chunks: [0, 2] },
    { start: 3000, end: 4000, words: [{ start: 3000, end: 4000 }], chunks: [0] },
  ];
  const none = () => ({ s: 0, e: 0 });
  it("chunks, sentences and groups", () => {
    expect(buildUnits(sents, "chunk", 2, none)).toEqual([
      { start: 0, end: 1500, sentence: 0 },
      { start: 1500, end: 3000, sentence: 0 },
      { start: 3000, end: 4000, sentence: 1 },
    ]);
    expect(buildUnits(sents, "multi", 2, none)).toEqual([{ start: 0, end: 4000, sentence: 0 }]);
  });
  it("applies saved timing corrections", () => {
    expect(buildUnits(sents, "sentence", 2, (i) => (i === 0 ? { s: -200, e: 100 } : { s: 0, e: 0 }))[0]).toEqual({ start: -200, end: 3100, sentence: 0 });
  });
});
