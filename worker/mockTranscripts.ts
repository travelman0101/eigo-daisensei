import type { Segment } from "../shared/types";

/**
 * Generated transcripts for local development and E2E (TRANSCRIPT_MOCK=1). Never used in production.
 * - mockLong60m: 60 minutes of auto-caption style lines (no punctuation)
 * - mockPunct01: 3 minutes of manual-caption style lines (with punctuation)
 * - mockNoSubs1: no transcript
 * - anything else: 2 minutes of auto-caption style lines
 */
const PHRASES = [
  "so today I want to talk about",
  "the way we learn new words",
  "and why listening again and again",
  "really helps you speak more naturally",
  "when I was a student",
  "I used to read everything out loud",
  "but I never listened to real people",
  "then one day I found a video",
  "that changed how I practice",
  "you know it was a simple idea",
];

export function mockTranscript(videoId: string): { segments: Segment[]; lang: string } | null {
  if (videoId === "mockNoSubs1") return null;
  const punct = videoId === "mockPunct01";
  const total = videoId === "mockLong60m" ? 3_600_000 : punct ? 180_000 : 120_000;
  const segments: Segment[] = [];
  let i = 0;
  for (let t = 1000; t < total - 3000; t += 3000, i++) {
    let text = `${PHRASES[i % PHRASES.length]} ${i}`;
    if (punct) text = text[0]!.toUpperCase() + text.slice(1) + (i % 2 ? "." : ",");
    segments.push({ text, start: t, dur: 2800 });
  }
  return { segments, lang: "en" };
}
