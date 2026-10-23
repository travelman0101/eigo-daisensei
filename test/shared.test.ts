import { describe, expect, it } from "vitest";
import { blocksForRange, buildBlocks } from "../shared/blocks";
import { materialId, rangeSuggestions, sentenceTiming, sentencesInRange, validateRange } from "../shared/material";
import { checkAnswer, clozeFromText, clozeFromWords, normalizeAnswer } from "../shared/quiz";
import {
  alignPunctuated,
  capLength,
  chunksFromMarked,
  fallbackChunks,
  fallbackMarks,
  marksFromCaptions,
  mergeBlockSpans,
  spansFromMarks,
} from "../shared/sentences";
import { newReview, review, isDue } from "../shared/srs";
import { parsePastedTranscript, parseSubtitles } from "../shared/subtitles";
import { cleanCaption, hasPunctuation, wordsFromSegments } from "../shared/text";
import type { Segment } from "../shared/types";
import { formatTime, parseTime, parseYouTubeUrl } from "../shared/youtube";

describe("parseYouTubeUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=arj7oStGLkU", "arj7oStGLkU", null],
    ["https://youtu.be/arj7oStGLkU?t=90", "arj7oStGLkU", 90_000],
    ["youtube.com/watch?v=arj7oStGLkU&t=1m30s", "arj7oStGLkU", 90_000],
    ["https://m.youtube.com/watch?v=arj7oStGLkU&list=PL123#t=5", "arj7oStGLkU", null],
    ["https://www.youtube.com/shorts/arj7oStGLkU", "arj7oStGLkU", null],
    ["https://www.youtube.com/embed/arj7oStGLkU?start=30", "arj7oStGLkU", 30_000],
    ["https://www.youtube.com/live/arj7oStGLkU", "arj7oStGLkU", null],
    ["https://music.youtube.com/watch?v=arj7oStGLkU", "arj7oStGLkU", null],
    ["arj7oStGLkU", "arj7oStGLkU", null],
  ])("%s", (url, id, t) => {
    const r = parseYouTubeUrl(url);
    expect(r).toMatchObject({ ok: true, videoId: id });
    if (t !== null && r.ok) expect(r.startMs).toBe(t);
  });

  it.each(["", "https://vimeo.com/123", "https://www.youtube.com/playlist?list=PL1", "https://evil.com/watch?v=arj7oStGLkU", "javascript:alert(1)", "https://youtube.com.evil.com/watch?v=arj7oStGLkU"])(
    "rejects %s",
    (url) => expect(parseYouTubeUrl(url).ok).toBe(false),
  );
});

describe("time", () => {
  it("parses common forms", () => {
    expect(parseTime("5:00")).toBe(300_000);
    expect(parseTime("1:02:03")).toBe(3_723_000);
    expect(parseTime("300")).toBe(300_000);
    expect(parseTime("5:00.5")).toBe(300_500);
    expect(parseTime("1m30s")).toBe(90_000);
    expect(parseTime("５：００")).toBe(300_000);
    expect(parseTime("5:70")).toBeNull();
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("")).toBeNull();
  });
  it("formats", () => {
    expect(formatTime(300_000)).toBe("5:00");
    expect(formatTime(3_723_400, true)).toBe("1:02:03.4");
  });
});

describe("validateRange", () => {
  const H = 3_600_000;
  it("accepts 05:00–10:00 of a 60 minute video", () => expect(validateRange(300_000, 600_000, H)).toBeNull());
  it("rejects bad ranges", () => {
    expect(validateRange(null, 1000, H)).toBe("empty");
    expect(validateRange(600_000, 300_000, H)).toBe("reversed");
    expect(validateRange(300_000, 300_000, H)).toBe("reversed");
    expect(validateRange(H + 1, H + 60_000, H)).toBe("outside");
    expect(validateRange(-1, 60_000, H)).toBe("outside");
    expect(validateRange(0, 11 * 60_000, H)).toBe("too_long");
    expect(validateRange(0, 1000, H)).toBe("too_short");
  });
});

const seg = (start: number, dur: number, text: string): Segment => ({ start, dur, text });

describe("words and blocks", () => {
  it("cleans captions", () => {
    expect(cleanCaption("it&#39;s &amp; <i>fine</i>\n ok")).toBe("it's & fine ok");
  });
  it("spreads segment time over words and clips overlaps", () => {
    const w = wordsFromSegments([seg(0, 5000, "hello there [Music]"), seg(2000, 1000, "bye")]);
    expect(w.map((x) => x.w)).toEqual(["hello", "there", "bye"]);
    expect(w[0]!.start).toBe(0);
    expect(w[1]!.end).toBe(2000); // clipped at the next line
    expect(w[2]).toMatchObject({ start: 2000, end: 3000, seg: 1 });
  });
  it("detects punctuation", () => {
    expect(hasPunctuation(wordsFromSegments([seg(0, 1000, "Hello there. How are you?")]))).toBe(true);
    expect(hasPunctuation(wordsFromSegments([seg(0, 1000, "hello there how are you")]))).toBe(false);
  });
  it("builds the same blocks regardless of range and cuts at the longest pause", () => {
    // one 2 s line every 3 s for 10 minutes; a long pause at 57–60 s
    const segs: Segment[] = [];
    for (let t = 0; t < 600_000; t += 3000) segs.push(seg(t, t === 54_000 ? 1000 : 2000, `line ${t}`));
    const b = buildBlocks(segs);
    expect(b[0]!.end).toBe(55_000);
    expect(b[1]!.start).toBe(57_000);
    expect(b.every((x) => x.end - x.start <= 72_000)).toBe(true);
    expect(buildBlocks(segs)).toEqual(b);
    const { core, withContext } = blocksForRange(b, 300_000, 360_000);
    expect(core.length).toBeGreaterThan(0);
    expect(withContext.length).toBe(core.length + 2);
  });
});

describe("sentences", () => {
  const words = "so i'm going to talk today and i want to start".split(" ");
  it("aligns AI punctuation without changing words", () => {
    const m = alignPunctuated(words, "So I'm going to talk today. And I want to start.");
    expect(m?.ends).toEqual([false, false, false, false, false, true, false, false, false, false, true]);
    expect(m?.display[1]).toBe("I'm");
  });
  it("rejects changed, dropped or added words", () => {
    expect(alignPunctuated(words, "So I am going to talk today. And I want to start.")).toBeNull();
    expect(alignPunctuated(words, "So I'm going to talk. And I want to start.")).toBeNull();
    expect(alignPunctuated(words, "So I'm going to talk today. And I want to start now.")).toBeNull();
  });
  it("ignores stray punctuation tokens and think tags", () => {
    expect(alignPunctuated(["yes", "no"], "<think>x</think> Yes — no .")?.ends).toEqual([false, true]);
  });
  it("splits mechanically on pauses and length", () => {
    const w = wordsFromSegments([seg(0, 1000, "one two"), seg(3000, 1000, "three four")]);
    expect(fallbackMarks(w).ends).toEqual([false, true, false, false]); // the last one stays open for the next block
  });
  it("does not end a sentence at abbreviations", () => {
    const w = wordsFromSegments([seg(0, 3000, "Hi, Dr. Jill. Mr. Smith lives in the U.S. now.")]);
    expect(spansFromMarks(marksFromCaptions(w), 0).map((x) => x.text)).toEqual(["Hi, Dr. Jill.", "Mr. Smith lives in the U.S. now."]);
  });
  it("uses caption punctuation", () => {
    const w = wordsFromSegments([seg(0, 1000, "Hi there. Bye")]);
    expect(spansFromMarks(marksFromCaptions(w), 0)).toEqual([
      { from: 0, to: 1, text: "Hi there.", closed: true },
      { from: 2, to: 2, text: "Bye", closed: false },
    ]);
  });
  it("merges a sentence left open at a block edge", () => {
    const merged = mergeBlockSpans([
      [{ from: 0, to: 1, text: "Hi there.", closed: true }, { from: 2, to: 3, text: "I went", closed: false }],
      [{ from: 4, to: 5, text: "home today.", closed: true }],
    ]);
    expect(merged).toEqual([
      { from: 0, to: 1, text: "Hi there.", closed: true },
      { from: 2, to: 5, text: "I went home today.", closed: true },
    ]);
  });
  it("caps very long sentences at a comma", () => {
    const toks = Array.from({ length: 40 }, (_, i) => (i === 18 ? "w18," : `w${i}`));
    const out = capLength([{ from: 0, to: 39, text: toks.join(" "), closed: true }]);
    expect(out.length).toBe(2);
    expect(out[0]!.to).toBe(18);
  });
  it("reads AI chunk marks and falls back", () => {
    const sw = "When I was in college, I was a major.".split(" ");
    expect(chunksFromMarked(sw, "When I was in college, / I was / a major.")).toEqual([0, 5, 7]);
    expect(chunksFromMarked(sw, "When I was at college, / I was / a major.")).toBeNull();
    expect(fallbackChunks(sw)).toEqual([0, 5]);
  });
  it("marks timing as estimated when a sentence starts inside a caption line", () => {
    const w = wordsFromSegments([seg(0, 2000, "Hi there. I went"), seg(2000, 1000, "home.")]);
    expect(sentenceTiming(w, { from: 0, to: 1, text: "", closed: true }).timing).toBe("estimated");
    expect(sentenceTiming(w, { from: 0, to: 4, text: "", closed: true })).toMatchObject({ start: 0, end: 3000, timing: "line" });
  });
});

describe("range edges", () => {
  const s = [
    { start: 290_000, end: 302_000, text: "A." },
    { start: 302_500, end: 400_000, text: "B." },
    { start: 595_000, end: 606_000, text: "C." },
  ];
  it("suggests widening or narrowing an edge that cuts a sentence", () => {
    expect(rangeSuggestions(s, 300_000, 600_000)).toEqual([
      { edge: "start", sentenceText: "A.", widen: 290_000, narrow: 302_500 },
      { edge: "end", sentenceText: "C.", widen: 606_000, narrow: 400_000 },
    ]);
    expect(rangeSuggestions(s, 290_000, 606_000)).toEqual([]);
  });
  it("flags edge sentences", () => {
    const r = sentencesInRange(s, 300_000, 600_000);
    expect(r.map((x) => x.edge)).toEqual([true, false, true]);
  });
  it("makes stable material ids", async () => {
    expect(await materialId("v", "en", "h", 1, 2)).toBe(await materialId("v", "en", "h", 1, 2));
    expect(await materialId("v", "en", "h", 1, 2)).not.toBe(await materialId("v", "en", "h", 1, 3));
  });
});

describe("quiz", () => {
  it("normalizes answers", () => {
    expect(normalizeAnswer("  Give   UP. ")).toBe("give up");
    expect(normalizeAnswer("don’t")).toBe("don't");
    expect(checkAnswer("Realized", ["realized", "realised"])).toBe(true);
    expect(checkAnswer("realize", ["realized"])).toBe(false);
    expect(checkAnswer("   ", [""])).toBe(false);
  });
  it("blanks source words", () => {
    const w = "I realized, I'd left my keys.".split(" ");
    expect(clozeFromWords(w, 1, 1)).toEqual({ before: "I", after: ", I'd left my keys.", answer: "realized" });
    expect(clozeFromWords(w, 4, 5)).toEqual({ before: "I realized, I'd left", after: ".", answer: "my keys" });
  });
  it("blanks text occurrences", () => {
    expect(clozeFromText("She gave up smoking.", "gave up")).toEqual({ before: "She", after: "smoking.", answer: "gave up" });
    expect(clozeFromText("Nothing here", "gave")).toBeNull();
  });
});

describe("srs", () => {
  it("moves boxes", () => {
    const now = 1_000_000;
    let r = newReview(now);
    expect(isDue(r, now)).toBe(true);
    r = review(r, true, now);
    expect(r.box).toBe(1);
    expect(isDue(r, now + 1000)).toBe(false);
    r = review(r, false, now);
    expect(r).toMatchObject({ box: 0, wrong: 1, right: 1 });
  });
});

describe("subtitle files", () => {
  it("parses SRT", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,500\nHello <b>there</b>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n";
    expect(parseSubtitles(srt)).toEqual([
      { text: "Hello there", start: 1000, dur: 1500 },
      { text: "Bye", start: 3000, dur: 1000 },
    ]);
  });
  it("parses VTT with settings and notes", () => {
    const vtt = "WEBVTT\n\nNOTE hi\n\n00:01.000 --> 00:02.000 align:start\nOne\ntwo\n\n01:00:00.000 --> 01:00:01.000\nLate";
    expect(parseSubtitles(vtt)).toEqual([
      { text: "One two", start: 1000, dur: 1000 },
      { text: "Late", start: 3_600_000, dur: 1000 },
    ]);
  });
  it("parses pasted YouTube transcript (both layouts)", () => {
    expect(parsePastedTranscript("Transcript\n0:00\nhello there\n0:04\nbye now")).toEqual([
      { text: "hello there", start: 0, dur: 4000 },
      { text: "bye now", start: 4000, dur: 3000 },
    ]);
    expect(parsePastedTranscript("1:00:01 late line")).toEqual([{ text: "late line", start: 3_601_000, dur: 3000 }]);
  });
});
