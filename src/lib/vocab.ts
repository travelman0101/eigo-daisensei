import { newReview } from "../../shared/srs";
import type { DictEntry, Material, Sentence } from "../../shared/types";
import { post } from "./api";
import { db, guard, type VocabItem, type VocabSource } from "./db";
import { markDirty } from "./sync";

export const vocabId = (e: DictEntry) => `${e.lemma.toLowerCase()}|${e.meaning}`;
const lookupKey = (term: string, sentence: string) => `${term.toLowerCase()}|${sentence}`;

/** Dictionary entry for a term in its sentence: from the device first, then the server (AI once, then cached). */
export async function lookupTerm(term: string, sentence: string): Promise<{ entry: DictEntry; fromDevice: boolean }> {
  const key = lookupKey(term, sentence);
  const local = await db().get("lookups", key);
  if (local) return { entry: local.entry, fromDevice: true };
  const r = await post<{ entry: DictEntry }>("/api/lookup", { term, sentence });
  await guard(db().put("lookups", { key, entry: r.entry }));
  return { entry: r.entry, fromDevice: false };
}

export function sourceOf(m: Material, s: Sentence, from: number, to: number): VocabSource {
  return {
    materialId: m.id,
    videoId: m.videoId,
    title: m.title,
    sentenceId: s.id,
    sentence: s.text,
    words: s.words.map((w) => w.w),
    wordFrom: from,
    wordTo: to,
    start: s.start,
    end: s.end,
  };
}

/**
 * Saves a term. The same base form with the same meaning is one card (the new scene is added as
 * another source); a different meaning of the same word becomes its own card.
 */
export async function saveVocab(entry: DictEntry, source: VocabSource): Promise<{ item: VocabItem; merged: boolean; otherSenses: number }> {
  const id = vocabId(entry);
  const now = Date.now();
  const existing = await db().get("vocab", id);
  let item: VocabItem;
  if (existing) {
    const has = existing.sources.some((s) => s.sentenceId === source.sentenceId && s.materialId === source.materialId);
    item = { ...existing, sources: has ? existing.sources : [...existing.sources, source], updatedAt: now };
  } else item = { id, term: entry.term, entry, sources: [source], review: newReview(now), createdAt: now, updatedAt: now };
  await guard(db().put("vocab", item));
  await markDirty("vocab", id);
  const all = await db().getAll("vocab");
  const otherSenses = all.filter((v) => v.id !== id && v.entry.lemma.toLowerCase() === entry.lemma.toLowerCase()).length;
  return { item, merged: !!existing, otherSenses };
}

export async function deleteVocab(id: string) {
  await db().delete("vocab", id);
  await markDirty("vocab", id, true);
}
