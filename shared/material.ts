import type { Segment, Sentence, SentenceSpan, Timing, Word } from "./types";

/** Longest range a single material may cover. See README「解析時間の上限」. */
export const MAX_RANGE_MS = 10 * 60 * 1000;
export const MIN_RANGE_MS = 3000;
/** a sentence this close outside the range edge still counts as inside */
const EDGE_TOLERANCE = 400;

export type RangeError = "empty" | "reversed" | "outside" | "too_long" | "too_short";

export const RANGE_MESSAGES: Record<RangeError, string> = {
  empty: "開始と終了を入力してください",
  reversed: "終了は開始より後にしてください",
  outside: "動画の長さの範囲で指定してください",
  too_long: `1 回に取り込めるのは ${MAX_RANGE_MS / 60000} 分までです。範囲を狭めるか、分けて取り込んでください`,
  too_short: "3 秒以上の範囲を指定してください",
};

export function validateRange(start: number | null, end: number | null, duration: number | null): RangeError | null {
  if (start == null || end == null || Number.isNaN(start) || Number.isNaN(end)) return "empty";
  if (start < 0 || (duration != null && duration > 0 && (start >= duration || end > duration + 1000))) return "outside";
  if (end <= start) return "reversed";
  if (end - start < MIN_RANGE_MS) return "too_short";
  if (end - start > MAX_RANGE_MS) return "too_long";
  return null;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const transcriptHash = (segments: Segment[]) =>
  sha256Hex(JSON.stringify(segments.map((s) => [s.start, s.dur, s.text]))).then((h) => h.slice(0, 32));

export const materialId = (videoId: string, lang: string, hash: string, start: number, end: number) =>
  sha256Hex(`${videoId}|${lang}|${hash}|${start}|${end}`).then((h) => `m_${h.slice(0, 24)}`);

/** Sentence time span and whether it is measured (caption line edges) or estimated (split inside a line). */
export function sentenceTiming(words: Word[], span: SentenceSpan): { start: number; end: number; timing: Timing } {
  const first = words[span.from]!;
  const last = words[span.to]!;
  const startsLine = span.from === 0 || words[span.from - 1]!.seg !== first.seg;
  const endsLine = span.to === words.length - 1 || words[span.to + 1]!.seg !== last.seg;
  return { start: first.start, end: last.end, timing: startsLine && endsLine ? "line" : "estimated" };
}

export interface RangeSuggestion {
  edge: "start" | "end";
  /** the range edge cuts this sentence */
  sentenceText: string;
  /** move the edge outward to include the whole sentence */
  widen: number;
  /** move the edge inward to drop the partial sentence */
  narrow: number | null;
}

/** For each range edge that falls inside a sentence, offers to widen or narrow to the sentence edge. */
export function rangeSuggestions(
  spans: { start: number; end: number; text: string }[],
  start: number,
  end: number,
): RangeSuggestion[] {
  const out: RangeSuggestion[] = [];
  const cutStart = spans.findIndex((s) => s.start < start - EDGE_TOLERANCE && s.end > start + EDGE_TOLERANCE);
  if (cutStart >= 0) {
    const s = spans[cutStart]!;
    const next = spans[cutStart + 1];
    out.push({ edge: "start", sentenceText: s.text, widen: s.start, narrow: next && next.start < end ? next.start : null });
  }
  const cutEnd = spans.findIndex((s) => s.start < end - EDGE_TOLERANCE && s.end > end + EDGE_TOLERANCE);
  if (cutEnd >= 0) {
    const s = spans[cutEnd]!;
    const prev = spans[cutEnd - 1];
    out.push({ edge: "end", sentenceText: s.text, widen: s.end, narrow: prev && prev.end > start ? prev.end : null });
  }
  return out;
}

/** Sentences that overlap [start, end); those sticking out past an edge are flagged `edge`. */
export function sentencesInRange<T extends { start: number; end: number }>(items: T[], start: number, end: number): (T & { edge: boolean })[] {
  return items
    .filter((s) => s.end > start + EDGE_TOLERANCE && s.start < end - EDGE_TOLERANCE)
    .map((s) => ({ ...s, edge: s.start < start - EDGE_TOLERANCE || s.end > end + EDGE_TOLERANCE }));
}

/** Words per minute over a set of sentences (for sample level notes). */
export function wordsPerMinute(sentences: Pick<Sentence, "words" | "start" | "end">[]): number {
  const words = sentences.reduce((n, s) => n + s.words.length, 0);
  const ms = sentences.reduce((n, s) => n + (s.end - s.start), 0);
  return ms > 0 ? Math.round(words / (ms / 60000)) : 0;
}
