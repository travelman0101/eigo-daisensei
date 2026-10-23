/** One caption line as delivered by the provider (or a parsed SRT/VTT cue). Times in ms. */
export interface Segment {
  text: string;
  start: number;
  dur: number;
}

export type TranscriptSource = "supadata" | "upload" | "paste" | "sample";

export interface Transcript {
  videoId: string;
  lang: string;
  /** sha-256 of the segments, identifies this version of the captions */
  hash: string;
  source: TranscriptSource;
  segments: Segment[];
  availableLangs?: string[];
}

/** A word of the original captions with its (possibly estimated) time span. */
export interface Word {
  w: string;
  start: number;
  end: number;
  /** index of the caption segment the word came from */
  seg: number;
}

export interface Block {
  index: number;
  /** first and last (inclusive) segment index */
  segFrom: number;
  segTo: number;
  start: number;
  end: number;
}

/** word index range [from, to] inclusive into the transcript word list */
export interface SentenceSpan {
  from: number;
  to: number;
  /** display text: the original words with restored punctuation/case */
  text: string;
  /** false when the sentence did not end with . ? ! (continues into the next block) */
  closed: boolean;
}

export type Timing = "line" | "estimated";

export interface Sentence {
  id: string;
  /** display text with restored punctuation; words are exactly the caption words */
  text: string;
  /** caption words with times */
  words: { w: string; start: number; end: number }[];
  start: number;
  end: number;
  timing: Timing;
  /** word indexes (within this sentence) where a meaning chunk begins; always starts with 0 */
  chunks: number[];
  ja: string;
  /** chunk split came from the AI (true) or the mechanical fallback (false) */
  chunksByAi: boolean;
  /** partly outside the selected range (kept as context) */
  edge?: boolean;
  /** first/last caption segment index covered */
  segFrom: number;
  segTo: number;
}

export interface Material {
  id: string;
  videoId: string;
  title: string;
  author?: string;
  videoDuration: number;
  lang: string;
  transcriptHash: string;
  source: TranscriptSource;
  /** selected range in ms */
  start: number;
  end: number;
  /** range the user asked for before adjusting it to sentence edges */
  requested?: { start: number; end: number };
  sentences: Sentence[];
  /** original caption lines inside the range, kept unmodified */
  segments: Segment[];
  analysisVersion: number;
  /** punctuation was restored by AI (captions had none) */
  punctuatedByAi: boolean;
  createdAt: number;
  updatedAt: number;
  sample?: SampleInfo;
  /** measured import timings (ms) and AI calls, for the usage screen */
  stats?: { transcriptMs: number; punctMs: number; translateMs: number; aiCalls: number; cachedCalls: number };
}

export interface SampleInfo {
  level: "A1" | "A2" | "B1" | "B2" | "C1";
  topic: string;
  reason: string;
  wpm: number;
  license: string;
  credit: string;
  sourceUrl: string;
}

export interface DictEntry {
  term: string;
  lemma: string;
  pos: string;
  meaning: string;
  /** one-line explanation of the meaning in this context */
  note: string;
  example: string;
  exampleJa: string;
  /** forms accepted when the learner types the term in the source sentence blank */
  accepted: string[];
  /** forms accepted for the example sentence blank */
  exampleAccepted: string[];
  /** the term as it appears inside `example` (to blank it out) */
  exampleSurface: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  picture: string | null;
}

export type UsageKind = "transcript" | "punct" | "translate" | "lookup";
