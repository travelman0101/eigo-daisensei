import type { Block, Segment } from "./types";

export const BLOCK_MIN = 50_000;
export const BLOCK_MAX = 70_000;

const segEnd = (segments: Segment[], i: number) => {
  const s = segments[i]!;
  const next = segments[i + 1];
  const end = s.start + s.dur;
  return next && next.start > s.start && next.start < end ? next.start : end;
};

/**
 * Cuts a transcript into ~1 minute blocks at caption boundaries. Within the 50–70 s window the cut
 * goes where the pause between lines is longest. The result depends only on the segments, so any
 * two ranges of the same transcript share the same blocks (and their cached analysis).
 */
export function buildBlocks(segments: Segment[]): Block[] {
  const blocks: Block[] = [];
  let from = 0;
  while (from < segments.length) {
    const t0 = segments[from]!.start;
    let cut = -1;
    let bestGap = -Infinity;
    for (let j = from; j < segments.length - 1; j++) {
      const nextStart = segments[j + 1]!.start;
      if (nextStart - t0 < BLOCK_MIN) continue;
      if (nextStart - t0 > BLOCK_MAX) {
        if (cut < 0) cut = j; // no boundary inside the window: take the first one after it
        break;
      }
      const gap = nextStart - segEnd(segments, j);
      if (gap > bestGap) {
        bestGap = gap;
        cut = j;
      }
    }
    if (cut < 0) cut = segments.length - 1;
    blocks.push({ index: blocks.length, segFrom: from, segTo: cut, start: t0, end: segEnd(segments, cut) });
    from = cut + 1;
  }
  return blocks;
}

/** Blocks overlapping [start, end), plus one neighbour on each side so sentence edges can be found. */
export function blocksForRange(blocks: Block[], start: number, end: number): { core: Block[]; withContext: Block[] } {
  const core = blocks.filter((b) => b.end > start && b.start < end);
  if (!core.length) return { core, withContext: core };
  const first = core[0]!.index;
  const last = core.at(-1)!.index;
  return { core, withContext: blocks.slice(Math.max(0, first - 1), last + 2) };
}
