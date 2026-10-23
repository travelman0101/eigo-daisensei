import type { Material, SampleInfo } from "../../shared/types";
import { db, guard } from "./db";

export interface SampleMeta extends SampleInfo {
  id: string;
  videoId: string;
  title: string;
  author: string;
  start: number;
  end: number;
  duration: number;
  sentences: number;
}

let index: Promise<SampleMeta[]> | null = null;

export function sampleIndex(): Promise<SampleMeta[]> {
  index ??= fetch("/samples/index.json")
    .then((r) => (r.ok ? (r.json() as Promise<SampleMeta[]>) : []))
    .catch(() => {
      index = null;
      return [];
    });
  return index!;
}

export const sampleMaterialId = (id: string) => `sample_${id}`;

/** Copies a built-in sample into the account's store (once) so progress and vocabulary work like any material. */
export async function openSample(id: string): Promise<string> {
  const mid = sampleMaterialId(id);
  if (await db().get("materials", mid)) return mid;
  const r = await fetch(`/samples/${encodeURIComponent(id)}.json`);
  if (!r.ok) throw new Error("見本教材を読み込めませんでした");
  const m = (await r.json()) as Material;
  await guard(db().put("materials", { ...m, id: mid }));
  return mid;
}

export const thumb = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

/** Replaces an already copied sample when the app ships a corrected version (progress is stored separately). */
export async function refreshSample(id: string): Promise<Material | null> {
  const mid = sampleMaterialId(id);
  const local = await db().get("materials", mid);
  try {
    const r = await fetch(`/samples/${encodeURIComponent(id)}.json`, { cache: "no-cache" });
    if (!r.ok) return null;
    const m = { ...((await r.json()) as Material), id: mid };
    if (local && JSON.stringify(local.sentences) === JSON.stringify(m.sentences)) return null;
    await guard(db().put("materials", m));
    return m;
  } catch {
    return null;
  }
}
