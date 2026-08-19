/**
 * Interval arithmetic: what is busy and what is left free.
 *
 * This lives in its own dependency-free module for two reasons. First, it is the
 * one part of Phase 8 that can get things wrong **silently**: a miscalculated gap
 * raises no error, it just produces a confident lie the user believes. Second, it
 * can be compiled on its own and exercised from a `.mjs`, which is how delicate
 * logic gets tested in this project.
 *
 * Everything is epoch milliseconds. Time zones are resolved before reaching this
 * module ([localtime.ts](localtime.ts)): mixing both concerns in one function is
 * exactly what makes a gap show up an hour off on two days of the year.
 */

export interface Interval {
  start: number;
  end: number;
}

/**
 * Whether two intervals actually clash.
 *
 * Touching is NOT overlapping: a 10:00-11:00 appointment and an 11:00-12:00 one are
 * back to back, not a conflict. Hence the strict comparisons — and they matter,
 * because Google returns events that end exactly when the window starts as being
 * "inside the range".
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Merges intervals that overlap or touch, in order.
 *
 * Touching ones get merged too: to subtract busy time, two back-to-back meetings
 * from 10 to 11 and from 11 to 12 are a single busy block from 10 to 12, and
 * treating them separately would leave a zero-minute free gap between them.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals.filter((interval) => interval.end > interval.start);
  if (valid.length === 0) return [];

  const sorted = [...valid].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0]! }];

  for (const interval of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * The free stretches inside `window` once `busy` is subtracted, at least `minMs` long.
 *
 * Busy time is clipped to the window before being subtracted: an appointment that
 * starts yesterday and ends today at noon takes up this morning and nothing else,
 * and without clipping it would drag the gap outside the requested range.
 */
export function freeGaps(window: Interval, busy: Interval[], minMs: number): Interval[] {
  if (window.end <= window.start) return [];

  const clipped = busy
    .map((interval) => ({
      start: Math.max(interval.start, window.start),
      end: Math.min(interval.end, window.end),
    }))
    .filter((interval) => interval.end > interval.start);

  const gaps: Interval[] = [];
  let cursor = window.start;

  for (const block of mergeIntervals(clipped)) {
    if (block.start - cursor >= minMs) gaps.push({ start: cursor, end: block.start });
    cursor = Math.max(cursor, block.end);
  }
  if (window.end - cursor >= minMs) gaps.push({ start: cursor, end: window.end });

  return gaps;
}
