import { normWord } from "./text";
import type { SentenceSpan, Word } from "./types";

const TERMINAL = /[.?!]["'”’)\]]*$/;
/** "Dr." "Mr." "U.S." "J." end with a period but do not end a sentence */
const ABBREVIATION = /^(mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|e\.g|i\.e|u\.s|u\.k|mt|ft|gen|gov|sen|rep|[a-z])\.$/i;
export const endsSentence = (token: string) => TERMINAL.test(token) && !ABBREVIATION.test(token.replace(/^["'(]+/, ""));
export const MAX_SENTENCE_WORDS = 30;
const FALLBACK_GAP = 700;
const FALLBACK_WORDS = 20;

export interface Marks {
  /** display form of each caption word (case and punctuation restored) */
  display: string[];
  /** a sentence ends after this word */
  ends: boolean[];
}

/**
 * Maps AI-punctuated text back onto the caption words. Returns null if the AI changed, added,
 * dropped or reordered any word, so the captions are never silently rewritten.
 */
export function alignPunctuated(words: string[], punctuated: string): Marks | null {
  const tokens = punctuated.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split(/\s+/).filter(Boolean);
  const display: string[] = [];
  const ends: boolean[] = [];
  let j = 0;
  for (let i = 0; i < words.length; i++) {
    const cw = normWord(words[i]!);
    if (!cw) {
      display.push(words[i]!);
      ends.push(false);
      continue;
    }
    // skip stray punctuation tokens ("—", "."), attaching a full stop to the previous word
    while (j < tokens.length && !normWord(tokens[j]!)) {
      if (TERMINAL.test(tokens[j]!) && ends.length) ends[ends.length - 1] = true;
      j++;
    }
    if (j >= tokens.length || normWord(tokens[j]!) !== cw) return null;
    display.push(tokens[j]!);
    ends.push(endsSentence(tokens[j]!));
    j++;
  }
  for (; j < tokens.length; j++) {
    if (normWord(tokens[j]!)) return null;
    if (TERMINAL.test(tokens[j]!) && ends.length) ends[ends.length - 1] = true;
  }
  return { display, ends };
}

/** Sentence ends taken from the captions' own punctuation (manual captions). */
export function marksFromCaptions(words: Word[]): Marks {
  return { display: words.map((w) => w.w), ends: words.map((w) => endsSentence(w.w)) };
}

/** Mechanical split when the AI result cannot be used: pauses ≥ 0.7 s, punctuation, or 20 words. */
export function fallbackMarks(words: Word[]): Marks {
  const ends: boolean[] = [];
  let count = 0;
  words.forEach((w, i) => {
    count++;
    const next = words[i + 1];
    const end = endsSentence(w.w) || (next ? next.start - w.end >= FALLBACK_GAP : false) || count >= FALLBACK_WORDS;
    ends.push(end);
    if (end) count = 0;
  });
  return { display: words.map((w) => w.w), ends };
}

/** Turns marks for words[from..to] into sentence spans with global word indexes. */
export function spansFromMarks(marks: Marks, from: number): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;
  marks.ends.forEach((end, i) => {
    const last = i === marks.ends.length - 1;
    if (!end && !last) return;
    spans.push({ from: from + start, to: from + i, text: marks.display.slice(start, i + 1).join(" "), closed: end });
    start = i + 1;
  });
  return capLength(spans);
}

/** Splits sentences longer than 30 words at the comma nearest the middle (or the middle). */
export function capLength(spans: SentenceSpan[]): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  const queue = [...spans];
  while (queue.length) {
    const s = queue.shift()!;
    const toks = s.text.split(" ");
    if (toks.length <= MAX_SENTENCE_WORDS || toks.length !== s.to - s.from + 1) {
      out.push(s);
      continue;
    }
    const mid = Math.floor(toks.length / 2);
    let cut = -1;
    for (let d = 0; d < mid - 3; d++) {
      for (const k of [mid + d, mid - d]) {
        if (cut < 0 && k > 2 && k < toks.length - 3 && /[,;:]$/.test(toks[k]!)) cut = k;
      }
    }
    if (cut < 0) cut = mid;
    queue.unshift(
      { from: s.from, to: s.from + cut, text: toks.slice(0, cut + 1).join(" "), closed: true },
      { from: s.from + cut + 1, to: s.to, text: toks.slice(cut + 1).join(" "), closed: s.closed },
    );
  }
  return out;
}

/** Joins per-block spans, merging a sentence left open at a block end with the next block's first. */
export function mergeBlockSpans(perBlock: SentenceSpan[][]): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  for (const spans of perBlock) {
    for (const s of spans) {
      const prev = out.at(-1);
      if (prev && !prev.closed && prev.to + 1 === s.from) {
        out[out.length - 1] = { from: prev.from, to: s.to, text: `${prev.text} ${s.text}`, closed: s.closed };
      } else out.push({ ...s });
    }
  }
  return capLength(out);
}

/** Chunk starts from an AI "a b / c d" string; null when the words differ from the sentence. */
export function chunksFromMarked(sentenceWords: string[], marked: string): number[] | null {
  const parts = marked.split("/").map((p) => p.trim().split(/\s+/).filter((t) => normWord(t)));
  const flat = parts.flat().map(normWord);
  const target = sentenceWords.map(normWord).filter(Boolean);
  if (flat.length !== target.length || flat.some((w, i) => w !== target[i])) return null;
  // map positions among non-empty words back to sentence word indexes
  const realIdx = sentenceWords.map((w, i) => (normWord(w) ? i : -1)).filter((i) => i >= 0);
  const starts: number[] = [];
  let k = 0;
  for (const p of parts) {
    if (!p.length) continue;
    starts.push(realIdx[k]!);
    k += p.length;
  }
  starts[0] = 0;
  return [...new Set(starts)];
}

/** Fallback chunks: split after commas, and every 5 words. */
export function fallbackChunks(sentenceWords: string[]): number[] {
  const starts = [0];
  let run = 0;
  sentenceWords.forEach((w, i) => {
    run++;
    if (i < sentenceWords.length - 1 && (/[,;:]$/.test(w) || run >= 5)) {
      starts.push(i + 1);
      run = 0;
    }
  });
  return starts;
}
