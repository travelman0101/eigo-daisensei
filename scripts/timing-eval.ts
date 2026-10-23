// Measures caption / sentence timing against real speech.
// Reference word times come from Workers AI Whisper run once on public-domain source media
// (VOA, NASA). Usage: npx tsx scripts/timing-eval.ts <sample.json> <whisper.json> [label]
import { readFileSync } from "node:fs";
import { normWord, wordsFromSegments } from "../shared/text";
import type { Material, Segment } from "../shared/types";

type WWord = { word: string; start: number; end: number };

const [, , samplePath, whisperPath, label = ""] = process.argv;
const m = JSON.parse(readFileSync(samplePath!, "utf8")) as Material;
const wj = JSON.parse(readFileSync(whisperPath!, "utf8")) as { words: WWord[] };
const ref = wj.words.map((w) => ({ w: normWord(w.word), start: w.start * 1000, end: w.end * 1000 })).filter((w) => w.w);

/** Longest common subsequence of two word lists → matched index pairs. */
function align(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const mm = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(mm + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = mm - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < mm) {
    if (a[i] === b[j]) out.push([i++, j++]);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
const p90 = (xs: number[]) => {
  const s = [...xs].map(Math.abs).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length * 0.9)]! : NaN;
};
const fmt = (xs: number[]) => `n=${xs.length} 中央値 ${Math.round(median(xs))}ms / |誤差| 中央値 ${Math.round(median(xs.map(Math.abs)))}ms / 90% ${Math.round(p90(xs))}ms`;

// caption words with the app's character-based estimates (what the material was built from)
const segs: Segment[] = m.segments;
const cap = wordsFromSegments(segs);
// restrict the reference to the clip's time window (+ margin) so repeated phrases elsewhere do not match
const window = (r: typeof ref, offset: number) => r.filter((w) => w.start >= m.start - 20_000 + offset && w.start <= m.end + 20_000 + offset);

// first pass: global LCS on a wide window to estimate the timeline offset between the YouTube video and the source file
const pairs0 = align(cap.map((w) => normWord(w.w)), ref.map((w) => w.w));
const lineStarts0 = pairs0.filter(([i]) => i === 0 || cap[i - 1]!.seg !== cap[i]!.seg);
const offset = median(lineStarts0.map(([i, j]) => ref[j]!.start - cap[i]!.start));
const refW = window(ref, offset);
const pairs = align(cap.map((w) => normWord(w.w)), refW.map((w) => w.w));
const at = new Map(pairs.map(([i, j]) => [i, refW[j]!]));

console.log(`## ${label || m.title}`);
console.log(`字幕の語 ${cap.length}・一致 ${pairs.length}（${Math.round((pairs.length / cap.length) * 100)}%）・動画と音源の時間差 ${Math.round(offset)}ms（全体で一定の差として補正）`);

// (a) original caption cue starts vs the speech of their first word
const cueStart: number[] = [];
cap.forEach((w, i) => {
  if (i > 0 && cap[i - 1]!.seg === w.seg) return;
  const r = at.get(i);
  if (r) cueStart.push(segs[w.seg]!.start - (r.start - offset));
});
console.log(`字幕行の開始 − 発話の開始: ${fmt(cueStart)}`);

// (b) every caption word: character-based estimate vs speech
const wordErr = cap.map((w, i) => (at.get(i) ? w.start - (at.get(i)!.start - offset) : NaN)).filter((x) => !Number.isNaN(x));
console.log(`単語の推定開始（文字数配分）− 発話: ${fmt(wordErr)}`);

// (c) sentences as stored in the material
const byText = new Map<string, number>();
cap.forEach((w, i) => byText.set(`${i}`, i));
let cursor = 0;
const sStart: Record<string, number[]> = { line: [], estimated: [] };
const sEnd: Record<string, number[]> = { line: [], estimated: [] };
for (const s of m.sentences) {
  // find the sentence's first caption word index by walking forward through the caption words
  const first = normWord(s.words[0]!.w);
  while (cursor < cap.length && !(normWord(cap[cursor]!.w) === first && Math.abs(cap[cursor]!.start - s.start) < 1500)) cursor++;
  if (cursor >= cap.length) break;
  const lastIdx = cursor + s.words.length - 1;
  const r0 = at.get(cursor);
  const r1 = at.get(lastIdx);
  if (r0) sStart[s.timing]!.push(s.start - (r0.start - offset));
  if (r1) sEnd[s.timing]!.push(s.end - (r1.end - offset));
  cursor = lastIdx + 1;
}
for (const k of ["line", "estimated"]) {
  console.log(`文の開始（${k === "line" ? "字幕行の境界" : "行の途中＝推定"}）− 発話: ${fmt(sStart[k]!)}`);
  console.log(`文の終了（${k === "line" ? "字幕行の境界" : "行の途中＝推定"}）− 発話: ${fmt(sEnd[k]!)}`);
}
console.log("（正の値＝アプリの時刻が発話より遅い。開始が遅い→語頭が切れる、終了が早い（負）→語尾が切れる）");

// ---- alternative estimators (same caption cues, different weights inside a cue) ----
const syllables = (w: string) => {
  const s = w.toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return 1;
  const groups = s.replace(/e$/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
};
// display tokens (with restored punctuation) in caption order
const disp = m.sentences.flatMap((s) => s.words.map((w) => w.w));
const dispFor: string[] = [];
{
  let k = 0;
  for (const w of cap) {
    while (k < disp.length && normWord(disp[k]!) !== normWord(w.w)) k++;
    dispFor.push(k < disp.length ? disp[k++]! : w.w);
  }
}
function estimate(weight: (i: number) => number) {
  const out = cap.map((w) => ({ ...w }));
  const bySeg = new Map<number, number[]>();
  cap.forEach((w, i) => bySeg.set(w.seg, [...(bySeg.get(w.seg) ?? []), i]));
  for (const [si, idx] of bySeg) {
    const seg = segs[si]!;
    const next = segs[si + 1];
    let end = seg.start + seg.dur;
    if (next && next.start > seg.start && next.start < end) end = next.start;
    const ws = idx.map(weight);
    const total = ws.reduce((a, b) => a + b, 0);
    let acc = 0;
    idx.forEach((i, k) => {
      out[i]!.start = seg.start + ((end - seg.start) * acc) / total;
      acc += ws[k]!;
      out[i]!.end = seg.start + ((end - seg.start) * acc) / total;
    });
  }
  return out;
}
const variants: Record<string, (i: number) => number> = {
  "文字数（現状）": (i) => cap[i]!.w.length + 1,
  "音節": (i) => syllables(cap[i]!.w) + 0.5,
  "音節＋句読点の間": (i) => syllables(cap[i]!.w) + 0.5 + (/[.?!]["')]*$/.test(dispFor[i]!) ? 2 : /[,;:]$/.test(dispFor[i]!) ? 1 : 0),
  "文字数＋句読点の間": (i) => cap[i]!.w.length + 1 + (/[.?!]["')]*$/.test(dispFor[i]!) ? 6 : /[,;:]$/.test(dispFor[i]!) ? 3 : 0),
};
console.log("-- 行の途中の文境界（推定）だけを比べる --");
for (const [name, fn] of Object.entries(variants)) {
  const est = estimate(fn);
  const st: number[] = [];
  const en: number[] = [];
  cap.forEach((w, i) => {
    const sameSegPrev = i > 0 && cap[i - 1]!.seg === w.seg;
    const sameSegNext = i < cap.length - 1 && cap[i + 1]!.seg === w.seg;
    const d = dispFor[i]!;
    // a sentence starts mid-cue here
    if (sameSegPrev && /[.?!]["')]*$/.test(dispFor[i - 1]!) && at.get(i)) st.push(est[i]!.start - (at.get(i)!.start - offset));
    // a sentence ends mid-cue here
    if (sameSegNext && /[.?!]["')]*$/.test(d) && at.get(i)) en.push(est[i]!.end - (at.get(i)!.end - offset));
  });
  console.log(`${name}: 開始 ${fmt(st)} ／ 終了 ${fmt(en)}`);
}
