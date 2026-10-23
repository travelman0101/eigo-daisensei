/**
 * Simple Leitner boxes. Box n is due `INTERVAL_DAYS[n]` days after the last review.
 * Right answer: one box up. Wrong answer: back to box 0, due now.
 */
export const INTERVAL_DAYS = [0, 1, 3, 7, 14] as const;
const DAY = 24 * 60 * 60 * 1000;

export interface ReviewState {
  box: number;
  due: number;
  right: number;
  wrong: number;
  lastResult?: "right" | "wrong";
  lastAt?: number;
}

export const newReview = (now: number): ReviewState => ({ box: 0, due: now, right: 0, wrong: 0 });

export function review(state: ReviewState, correct: boolean, now: number): ReviewState {
  if (!correct) return { ...state, box: 0, due: now, wrong: state.wrong + 1, lastResult: "wrong", lastAt: now };
  const box = Math.min(state.box + 1, INTERVAL_DAYS.length - 1);
  return { ...state, box, due: now + INTERVAL_DAYS[box]! * DAY, right: state.right + 1, lastResult: "right", lastAt: now };
}

export const isDue = (s: ReviewState, now: number) => s.due <= now;
