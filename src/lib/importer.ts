import { blocksForRange, buildBlocks } from "../../shared/blocks";
import { materialId, rangeSuggestions, sentenceTiming, sentencesInRange, type RangeSuggestion } from "../../shared/material";
import { fallbackChunks, fallbackMarks, marksFromCaptions, mergeBlockSpans, spansFromMarks, type Marks } from "../../shared/sentences";
import { hasPunctuation, wordsFromSegments } from "../../shared/text";
import type { Material, Sentence, SentenceSpan, Timing, Transcript, Word } from "../../shared/types";
import { post } from "./api";
import { db, guard, type ImportJob } from "./db";
import { markDirty } from "./sync";

/** Bump when the client-side assembly changes. Old materials are kept as they are (no automatic re-analysis). */
export const ANALYSIS_VERSION = 1;
const TRANSLATE_BATCH = 6;
const PARALLEL = 3;

export interface Progress {
  stage: "punct" | "translate" | "save";
  done: number;
  total: number;
}

export interface CallStats {
  ai: number;
  cached: number;
}

export interface Prepared {
  words: Word[];
  spans: (SentenceSpan & { start: number; end: number; timing: Timing })[];
  punctuatedByAi: boolean;
  suggestions: RangeSuggestion[];
  job: ImportJob;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        signal?.throwIfAborted();
        await fn(items[next++]!);
      }
    }),
  );
}

export const jobKey = (videoId: string, hash: string, start: number, end: number) => `${videoId}|${hash}|${start}|${end}`;

async function saveJob(job: ImportJob) {
  job.updatedAt = Date.now();
  await guard(db().put("jobs", job));
}

/**
 * Phase 1: sentence boundaries for the blocks around [start, end). Captions with punctuation need no
 * AI; others get punctuation restored block by block (each block cached on the server and in the job).
 */
export async function prepare(
  t: Transcript,
  meta: { title: string; author: string; duration: number },
  start: number,
  end: number,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
  calls: CallStats = { ai: 0, cached: 0 },
): Promise<Prepared> {
  const words = wordsFromSegments(t.segments);
  const blocks = buildBlocks(t.segments);
  const { withContext } = blocksForRange(blocks, start, end);
  const key = jobKey(t.videoId, t.hash, start, end);
  const job: ImportJob = (await db().get("jobs", key)) ?? {
    key,
    videoId: t.videoId,
    start,
    end,
    title: meta.title,
    author: meta.author,
    duration: meta.duration,
    transcriptHash: t.hash,
    marks: {},
    translations: {},
    updatedAt: Date.now(),
  };
  const punctuated = hasPunctuation(words);
  const wordRange = (b: (typeof blocks)[number]) => {
    const from = words.findIndex((w) => w.seg >= b.segFrom);
    let to = from;
    while (to + 1 < words.length && words[to + 1]!.seg <= b.segTo) to++;
    return from < 0 || words[from]!.seg > b.segTo ? null : { from, to };
  };
  let done = 0;
  onProgress({ stage: "punct", done, total: withContext.length });
  const perBlock = new Map<number, SentenceSpan[]>();
  await pool(
    withContext,
    PARALLEL,
    async (b) => {
      const r = wordRange(b);
      if (r) {
        const bw = words.slice(r.from, r.to + 1);
        let marks: Marks;
        if (punctuated) marks = marksFromCaptions(bw);
        else {
          let m = job.marks[b.index];
          if (!m) {
            const res = await post<{ marks: Marks | null; cached: boolean }>("/api/analyze/punct", { words: bw.map((w) => w.w) }, signal);
            calls[res.cached ? "cached" : "ai"]++;
            m = res.marks ?? "fallback";
            job.marks[b.index] = m;
            await saveJob(job);
          }
          marks = m === "fallback" ? fallbackMarks(bw) : m;
        }
        perBlock.set(b.index, spansFromMarks(marks, r.from));
      }
      onProgress({ stage: "punct", done: ++done, total: withContext.length });
    },
    signal,
  );
  const merged = mergeBlockSpans(withContext.map((b) => perBlock.get(b.index) ?? []));
  const spans = merged.map((s) => ({ ...s, ...sentenceTiming(words, s) }));
  return { words, spans, punctuatedByAi: !punctuated, suggestions: rangeSuggestions(spans, start, end), job };
}

/** Phase 2: translate the sentences in the final range (cached per sentence) and save the material. */
export async function build(
  t: Transcript,
  prep: Prepared,
  start: number,
  end: number,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
  calls: CallStats = { ai: 0, cached: 0 },
  stats?: Material["stats"],
): Promise<Material> {
  const { job } = prep;
  const inRange = sentencesInRange(prep.spans, start, end);
  const todo = [...new Set(inRange.map((s) => s.text))].filter((s) => !job.translations[s]);
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += TRANSLATE_BATCH) batches.push(todo.slice(i, i + TRANSLATE_BATCH));
  let done = 0;
  onProgress({ stage: "translate", done, total: batches.length });
  await pool(
    batches,
    PARALLEL,
    async (batch) => {
      const res = await post<{ items: ({ ja: string; chunks: number[] | null } | null)[]; cached: boolean }>("/api/analyze/translate", { sentences: batch }, signal);
      calls[res.cached ? "cached" : "ai"]++;
      batch.forEach((s, i) => {
        const it = res.items[i];
        if (it) job.translations[s] = it;
      });
      await saveJob(job);
      onProgress({ stage: "translate", done: ++done, total: batches.length });
    },
    signal,
  );
  onProgress({ stage: "save", done: 0, total: 1 });
  const id = await materialId(t.videoId, t.lang, t.hash, start, end);
  const sentences: Sentence[] = inRange.map((s, i) => {
    const toks = s.text.split(" ");
    const tr = job.translations[s.text];
    return {
      id: `s${i}_${s.start}`,
      text: s.text,
      words: prep.words.slice(s.from, s.to + 1).map((w, k) => ({ w: toks[k] ?? w.w, start: w.start, end: w.end })),
      start: s.start,
      end: s.end,
      timing: s.timing,
      chunks: tr?.chunks ?? fallbackChunks(toks),
      chunksByAi: !!tr?.chunks,
      ja: tr?.ja ?? "",
      edge: s.edge,
      segFrom: prep.words[s.from]!.seg,
      segTo: prep.words[s.to]!.seg,
    };
  });
  const now = Date.now();
  const material: Material = {
    id,
    videoId: t.videoId,
    title: job.title,
    author: job.author,
    videoDuration: job.duration,
    lang: t.lang,
    transcriptHash: t.hash,
    source: t.source,
    start,
    end,
    requested: { start: job.start, end: job.end },
    sentences,
    segments: t.segments.filter((g) => g.start + g.dur > start && g.start < end),
    analysisVersion: ANALYSIS_VERSION,
    punctuatedByAi: prep.punctuatedByAi,
    createdAt: now,
    updatedAt: now,
    ...(stats ? { stats: { ...stats, aiCalls: calls.ai, cachedCalls: calls.cached } } : {}),
  };
  await guard(db().put("materials", material));
  await db().delete("jobs", job.key);
  await markDirty("material", id);
  return material;
}

/** Sentences of a material still missing a translation (a batch failed); they can be retried. */
export const untranslated = (m: Material) => m.sentences.filter((s) => !s.ja).length;

export async function saveTranscript(t: Transcript) {
  await guard(db().put("transcripts", { key: `${t.videoId}|${t.lang}|${t.source}`, transcript: t, savedAt: Date.now() }));
}

export async function localTranscript(videoId: string): Promise<Transcript | null> {
  const all = await db().getAll("transcripts");
  const mine = all.filter((r) => r.transcript.videoId === videoId).sort((a, b) => b.savedAt - a.savedAt);
  return mine[0]?.transcript ?? null;
}
