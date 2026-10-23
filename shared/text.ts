import type { Segment, Word } from "./types";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Decodes HTML entities and strips markup the providers leave in caption text. */
export function cleanCaption(text: string): string {
  return text
    .replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
      if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()]!;
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return m;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Non-speech annotations such as [Music], (applause), ♪ */
const isAnnotation = (w: string) => /^[[(].*[\])]$/.test(w) || /^[♪♫#*]+$/.test(w) || w === ">>" || w === "-";

/** Word form used to compare caption words with AI output: case, quotes and punctuation removed. */
export function normWord(w: string): string {
  return w
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[^a-z0-9'%$]+/g, "")
    .replace(/^'+|'+$/g, "");
}

/**
 * Splits caption segments into words and spreads each segment's time over its words by
 * character count. These per-word times are estimates; only segment edges come from the provider.
 */
export function wordsFromSegments(segments: Segment[]): Word[] {
  const out: Word[] = [];
  // bracketed annotations can span several tokens ("[Music playing]"), so remove them before splitting
  segments.forEach((seg, si) => {
    const text = cleanCaption(seg.text).replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
    const tokens = text.split(" ").filter((w) => w && !isAnnotation(w));
    if (!tokens.length) return;
    const next = segments[si + 1];
    // auto captions overlap the next line; a word cannot be spoken after the next line starts
    let end = seg.start + Math.max(seg.dur, 1);
    if (next && next.start > seg.start && next.start < end) end = next.start;
    const span = end - seg.start;
    const weights = tokens.map((w) => w.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    tokens.forEach((w, i) => {
      const s = seg.start + (span * acc) / total;
      acc += weights[i]!;
      out.push({ w, start: Math.round(s), end: Math.round(seg.start + (span * acc) / total), seg: si });
    });
  });
  return out;
}

/** True when a caption track already carries sentence punctuation (manual captions usually do). */
export function hasPunctuation(words: Word[]): boolean {
  if (words.length < 20) return words.some((w) => /[.?!]["')\]]*$/.test(w.w));
  const ends = words.filter((w) => /[.?!]["')\]]*$/.test(w.w)).length;
  return ends / words.length > 1 / 40;
}
