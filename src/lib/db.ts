import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Marks } from "../../shared/sentences";
import type { ReviewState } from "../../shared/srs";
import type { DictEntry, Material, Transcript } from "../../shared/types";

export type Rating = "hard" | "again" | "ok";

export interface Progress {
  materialId: string;
  /** index of the last practiced unit (sentence index) */
  sentenceIndex: number;
  ratings: Record<string, Rating>;
  /** manual timing correction per sentence, ms */
  adjust: Record<string, { s: number; e: number }>;
  /** shift applied to every sentence of this material (same delay everywhere), ms */
  offset?: number;
  /** where playback was (ms), so a long sentence resumes in the middle */
  pos?: number;
  /** the repeated part (a picked phrase or an A–B from the settings), with its fine-tuned edges */
  loop?: { a: number; b: number; sentenceId?: string; from?: number; to?: number };
  plays: number;
  lastAt: number;
  updatedAt: number;
}

export interface VocabSource {
  materialId: string;
  videoId: string;
  title: string;
  sentenceId: string;
  sentence: string;
  words: string[];
  wordFrom: number;
  wordTo: number;
  start: number;
  end: number;
}

export interface VocabItem {
  id: string;
  term: string;
  entry: DictEntry;
  sources: VocabSource[];
  review: ReviewState;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface TestResult {
  id?: number;
  vocabId: string;
  type: "card" | "cloze" | "example";
  correct: boolean;
  answer?: string;
  at: number;
}

/** Partial analysis kept while an import runs, so leaving the screen or a failure loses nothing. */
export interface ImportJob {
  key: string;
  videoId: string;
  start: number;
  end: number;
  title: string;
  author: string;
  duration: number;
  transcriptHash: string;
  marks: Record<number, Marks | "fallback">;
  translations: Record<string, { ja: string; chunks: number[] | null }>;
  updatedAt: number;
}

export interface Settings {
  /** flow: play straight through, highlight follows. single: one unit at a time with stops/repeats */
  practice: "flow" | "single";
  /** show the highlight this much later (Bluetooth earphones play the audio late), ms */
  displayDelay: number;
  /** extra margin on sentence edges whose time is estimated inside a caption line (one-sentence practice), ms */
  estMargin: number;
  /** (old) one value for every video; read once to move it into seekByVideo */
  seekSeconds?: number;
  /** seconds moved by a double tap on the left / right half of the subtitles, per YouTube video id (unset = 5) */
  seekByVideo: Record<string, number>;
  seekMigrated?: boolean;
  unit: "chunk" | "sentence" | "multi";
  multiCount: number;
  mode: "listen" | "repeat" | "shadow";
  repeats: number;
  gapMode: "none" | "fixed" | "ratio";
  gapFixed: number;
  gapRatio: number;
  rate: number;
  autoStop: boolean;
  showEn: boolean;
  showJa: boolean;
  view: "current" | "list";
  padPre: number;
  padPost: number;
  step: number;
}

/**
 * Developer's suggested defaults (not scientifically optimal values):
 * 3 repeats, a gap as long as what was just heard (time to say it back), and small paddings so
 * estimated sentence times do not clip the first or last syllable.
 */
export const DEFAULT_SETTINGS: Settings = {
  practice: "flow",
  displayDelay: 0,
  estMargin: 200,
  seekByVideo: {},
  unit: "sentence",
  multiCount: 2,
  mode: "repeat",
  repeats: 3,
  gapMode: "ratio",
  gapFixed: 2,
  gapRatio: 1,
  rate: 1,
  autoStop: true,
  showEn: true,
  showJa: true,
  view: "current",
  padPre: 150,
  padPost: 250,
  step: 4,
};

interface Schema extends DBSchema {
  transcripts: { key: string; value: { key: string; transcript: Transcript; savedAt: number } };
  materials: { key: string; value: Material; indexes: { byVideo: string } };
  progress: { key: string; value: Progress };
  vocab: { key: string; value: VocabItem };
  results: { key: number; value: TestResult };
  lookups: { key: string; value: { key: string; entry: DictEntry } };
  jobs: { key: string; value: ImportJob };
  kv: { key: string; value: { key: string; value: unknown; updatedAt: number } };
  outbox: { key: string; value: { key: string; kind: string; id: string; updatedAt: number } };
}

export type Store = IDBPDatabase<Schema>;

let current: { name: string; db: Store } | null = null;

/** One database per account ("guest" before login), so another account on a shared device sees nothing. */
export async function openStore(accountId: string): Promise<Store> {
  const name = `eigo:${accountId}`;
  if (current?.name === name) return current.db;
  current?.db.close();
  const db = await openDB<Schema>(name, 1, {
    upgrade(d) {
      d.createObjectStore("transcripts", { keyPath: "key" });
      d.createObjectStore("materials", { keyPath: "id" }).createIndex("byVideo", "videoId");
      d.createObjectStore("progress", { keyPath: "materialId" });
      d.createObjectStore("vocab", { keyPath: "id" });
      d.createObjectStore("results", { keyPath: "id", autoIncrement: true });
      d.createObjectStore("lookups", { keyPath: "key" });
      d.createObjectStore("jobs", { keyPath: "key" });
      d.createObjectStore("kv", { keyPath: "key" });
      d.createObjectStore("outbox", { keyPath: "key" });
    },
    blocking() {
      // another tab upgrades or deletes this database: let it
      current?.db.close();
      current = null;
    },
  });
  current = { name, db };
  return db;
}

export const db = () => {
  if (!current) throw new Error("store not open");
  return current.db;
};

/** Thrown when the browser refuses to store data (quota, private mode, disk full). */
export class SaveError extends Error {}

export async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const name = (e as DOMException)?.name;
    throw new SaveError(name === "QuotaExceededError" ? "端末の空き容量が足りず保存できませんでした" : "この端末に保存できませんでした");
  }
}

export async function getKv<T>(key: string, fallback: T): Promise<T> {
  const row = await db().get("kv", key);
  return row ? (row.value as T) : fallback;
}

export const setKv = (key: string, value: unknown) => guard(db().put("kv", { key, value, updatedAt: Date.now() }));

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await getKv<Partial<Settings>>("settings", {})) };
}

export async function deleteAccountStore(accountId: string) {
  if (current?.name === `eigo:${accountId}`) {
    current.db.close();
    current = null;
  }
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase(`eigo:${accountId}`);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}

/** Asks the browser not to evict our data under storage pressure (Chrome/Firefox/Safari 17+). */
export async function requestPersistence(): Promise<{ persisted: boolean; usage?: number; quota?: number }> {
  try {
    const persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false;
    const est = await navigator.storage?.estimate?.();
    return { persisted, usage: est?.usage, quota: est?.quota };
  } catch {
    return { persisted: false };
  }
}
