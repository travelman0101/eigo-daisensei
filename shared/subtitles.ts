import { cleanCaption } from "./text";
import type { Segment } from "./types";

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

const TS = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const toMs = (m: RegExpMatchArray) =>
  ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]!.padEnd(3, "0"));

const INLINE_TS = /<((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})>/;

/**
 * A VTT line with per-word time tags ("how<00:00:01.500><c> are</c>", as in YouTube auto captions)
 * becomes one segment per timed piece, so the real word times are kept instead of estimated.
 */
function timedPieces(line: string, cueStart: number, cueEnd: number): Segment[] {
  const parts = line.split(INLINE_TS);
  const pieces: { start: number; text: string }[] = [];
  pieces.push({ start: cueStart, text: parts[0]! });
  for (let k = 1; k < parts.length; k += 2) pieces.push({ start: toMs(parts[k]!.match(TS)!), text: parts[k + 1] ?? "" });
  const clean = pieces.map((p) => ({ ...p, text: cleanCaption(p.text) })).filter((p) => p.text);
  return clean.map((p, i) => {
    const end = clean[i + 1]?.start ?? cueEnd;
    return { text: p.text, start: p.start, dur: Math.max(1, end - p.start) };
  });
}

/** Parses SRT or WebVTT text into segments (cue settings, styling and NOTE blocks ignored). */
export function parseSubtitles(text: string): Segment[] {
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const out: Segment[] = [];
  const wordTimed = INLINE_TS.test(text);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti]!.split("-->");
    const ma = a!.match(TS);
    const mb = b!.match(TS);
    if (!ma || !mb) continue;
    const start = toMs(ma);
    const end = toMs(mb);
    if (end <= start) continue;
    if (wordTimed) {
      // YouTube repeats the previous line above the new one; only lines with time tags are new speech
      for (const l of lines.slice(ti + 1).filter((l) => INLINE_TS.test(l))) out.push(...timedPieces(l, start, end));
      continue;
    }
    const body = cleanCaption(lines.slice(ti + 1).join(" "));
    if (!body) continue;
    out.push({ text: body, start, dur: end - start });
  }
  return out.sort((x, y) => x.start - y.start);
}

/**
 * Parses text copied from YouTube's "Show transcript" panel. Accepts "0:05 text", or a time line
 * followed by text lines. Each line lasts until the next one starts (times are whole seconds).
 */
export function parsePastedTranscript(text: string): Segment[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  const items: { start: number; text: string }[] = [];
  const time = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/;
  for (const line of lines) {
    const inline = line.match(/^((?:\d+:)?\d{1,2}:\d{2})\s+(.+)$/);
    const only = line.match(time);
    if (only) items.push({ start: ((Number(only[1] ?? 0) * 60 + Number(only[2])) * 60 + Number(only[3])) * 1000, text: "" });
    else if (inline) {
      const m = inline[1]!.match(time)!;
      items.push({ start: ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000, text: inline[2]! });
    } else if (items.length) items[items.length - 1]!.text += (items.at(-1)!.text ? " " : "") + line;
    // a line before the first timestamp ("Transcript", chapter titles) is ignored
  }
  const valid = items.map((i) => ({ ...i, text: cleanCaption(i.text) })).filter((i) => i.text);
  return valid.map((it, k) => {
    const next = valid[k + 1];
    return { text: it.text, start: it.start, dur: next && next.start > it.start ? next.start - it.start : 3000 };
  });
}
