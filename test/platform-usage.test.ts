/**
 * ADR-0077 slice 10 — the usage dashboard's read model.
 *
 * r113 shipped the meter; this is what reads it. The tests worth writing are not about summing columns
 * — they are about the two ways a usage dashboard lies:
 *
 *   1. IT RENDERS A CONFIDENT TOTAL OVER STALE DATA. There are no `aihr` timers installed on the host,
 *      so the capture has never run on a schedule. A figure with no staleness qualifier converts a
 *      visible absence ("nobody has run the sweep") into an invisible one ("here is your usage").
 *   2. IT ADDS TENANTS METERED ON DIFFERENT DAYS. Each tenant is summarised at ITS OWN latest capture,
 *      so collapsing them into one total is the r118 mixed-currency mistake in another costume.
 *
 * `countMissingDays` is exported and tested directly because the arithmetic is what would silently
 * under-report, and every missing day is revenue that CANNOT be recovered — usage has no backfill.
 */
import { describe, expect, it } from 'vitest';
import { countMissingDays } from '../core/platform-usage';

const days = (from: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10),
  );

describe('slice 10 — missing capture days are counted, not glossed over', () => {
  it('a fully metered window reports ZERO missing days', () => {
    const covered = new Set(days('2026-08-03', 30));
    expect(countMissingDays(covered, '2026-08-03', 30)).toBe(0);
  });

  it('a meter that has NEVER run reports the whole window', () => {
    // This is production today: no timers installed, so the sweep runs only when someone runs it.
    expect(countMissingDays(new Set(), '2026-08-03', 30)).toBe(30);
  });

  it('counts the gap when the sweep stopped part-way through the window', () => {
    // Captured for the first 10 days ending 2026-07-14, then nothing.
    const covered = new Set(days('2026-07-14', 10));
    expect(countMissingDays(covered, '2026-08-03', 30)).toBe(20);
  });

  it('the window INCLUDES asOf — today is a day that can be missing', () => {
    const covered = new Set(days('2026-08-02', 29)); // everything except asOf itself
    expect(countMissingDays(covered, '2026-08-03', 30)).toBe(1);
  });

  it('captures OUTSIDE the window do not paper over gaps inside it', () => {
    // A single ancient capture must not make the window look covered.
    expect(countMissingDays(new Set(['2020-01-01']), '2026-08-03', 7)).toBe(7);
  });

  it('a one-day window is still a real question', () => {
    expect(countMissingDays(new Set(['2026-08-03']), '2026-08-03', 1)).toBe(0);
    expect(countMissingDays(new Set(['2026-08-02']), '2026-08-03', 1)).toBe(1);
  });
});
