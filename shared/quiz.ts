/** Answer form for comparison: width, case, quote style and surrounding punctuation/space ignored. */
export function normalizeAnswer(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'.,!?;:()]+|[\s"'.,!?;:()]+$/g, "");
}

export function checkAnswer(input: string, accepted: string[]): boolean {
  const a = normalizeAnswer(input);
  return !!a && accepted.some((x) => normalizeAnswer(x) === a);
}

export interface Cloze {
  before: string;
  after: string;
  answer: string;
}

/** Blanks words[from..to] of a sentence. */
export function clozeFromWords(words: string[], from: number, to: number): Cloze {
  const inner = words.slice(from, to + 1).join(" ");
  const lead = inner.match(/^["'(]+/)?.[0] ?? "";
  const trail = inner.match(/[.,!?;:"')]+$/)?.[0] ?? "";
  return {
    before: (words.slice(0, from).join(" ") + (lead ? ` ${lead}` : "")).trim(),
    after: (trail + " " + words.slice(to + 1).join(" ")).trim(),
    answer: inner.slice(lead.length, inner.length - trail.length),
  };
}

/** Blanks the first occurrence of `surface` in a sentence (case-insensitive, whole words). */
export function clozeFromText(sentence: string, surface: string): Cloze | null {
  if (!surface.trim()) return null;
  const esc = surface.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const m = new RegExp(`(^|[^A-Za-z0-9'])(${esc})(?![A-Za-z0-9])`, "i").exec(sentence);
  if (!m) return null;
  const at = m.index + m[1]!.length;
  return { before: sentence.slice(0, at).trimEnd(), after: sentence.slice(at + m[2]!.length).trimStart(), answer: m[2]! };
}
