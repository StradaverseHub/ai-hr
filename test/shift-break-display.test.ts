/**
 * Unit test for the Attendance Policy shift summary table's Break Time formatter
 * (Configurable Multi-Shift Attendance Management). Pure function, no DB — covers the four cases the plan
 * calls out: multi-break array present, empty array, null/absent (falls back to breakMinutes), and the
 * mismatch case (breakPeriods present but their sum disagrees with the canonical breakMinutes scalar).
 *
 * cf21e554 stage 1 extends it with the reference Break tab's three missing columns — Sequence No.,
 * Duration and Paid? — and with the one that changes an answer rather than adding a column: the mismatch
 * badge now compares against the UNPAID sum, because that is what core/roster.ts persists as break_minutes
 * and therefore what the hours engine deducts.
 */
import { describe, expect, it } from 'vitest';
import { formatBreakDisplay } from '../core/shift-break-display';

describe('formatBreakDisplay', () => {
  it('renders a single break window numbered, with its own duration', () => {
    const r = formatBreakDisplay([{ start: '12:00:00', end: '13:00:00' }], 60);
    expect(r.text).toBe('1. 12:00–13:00 (60m)');
    expect(r.rows).toEqual([{ seq: 1, start: '12:00', end: '13:00', minutes: 60, paid: false }]);
    expect(r.mismatchMinutes).toBeUndefined();
  });

  it('renders multiple break windows in order, each with its sequence number and duration', () => {
    const r = formatBreakDisplay(
      [
        { start: '12:00', end: '13:00' },
        { start: '15:00', end: '15:15' },
      ],
      75,
    );
    expect(r.text).toBe('1. 12:00–13:00 (60m), 2. 15:00–15:15 (15m)');
    expect(r.rows.map((x) => x.seq)).toEqual([1, 2]);
    expect(r.rows.map((x) => x.minutes)).toEqual([60, 15]);
    expect(r.mismatchMinutes).toBeUndefined();
  });

  it('flags a mismatch when the periods sum differs from breakMinutes (breakMinutes wins for hours math)', () => {
    // periods sum to 75 min but the saved scalar the engine deducts is 60.
    const r = formatBreakDisplay(
      [
        { start: '12:00', end: '13:00' },
        { start: '15:00', end: '15:15' },
      ],
      60,
    );
    expect(r.mismatchMinutes).toBe(60);
  });

  describe('cf21e554 — the Paid? column', () => {
    it('marks a paid row and does NOT count it towards the mismatch check', () => {
      // 60m unpaid + 15m PAID. core/roster.ts stores break_minutes = 60 (the unpaid sum), so 60 is correct
      // and the badge must stay off. Before this change the formatter compared against 75 and would have
      // flagged every correctly-saved shift that had a paid break.
      const r = formatBreakDisplay(
        [
          { start: '12:00', end: '13:00' },
          { start: '15:00', end: '15:15', paid: true },
        ],
        60,
      );
      expect(r.rows.map((x) => x.paid)).toEqual([false, true]);
      expect(r.mismatchMinutes).toBeUndefined();
    });

    it('still flags a genuine mismatch once the paid rows are excluded', () => {
      // 60m unpaid + 15m paid ⇒ the honest scalar is 60; a stored 75 is drifted and must be surfaced.
      const r = formatBreakDisplay(
        [
          { start: '12:00', end: '13:00' },
          { start: '15:00', end: '15:15', paid: true },
        ],
        75,
      );
      expect(r.mismatchMinutes).toBe(75);
    });

    it('a window with no `paid` key reads as UNPAID — every legacy row is unchanged', () => {
      const r = formatBreakDisplay([{ start: '12:00', end: '13:00' }], 60);
      expect(r.rows[0].paid).toBe(false);
    });
  });

  it('falls back to the breakMinutes scalar when there are no break windows (empty array)', () => {
    const r = formatBreakDisplay([], 45);
    expect(r.text).toBe('45 min');
    expect(r.rows).toEqual([]);
    expect(r.mismatchMinutes).toBeUndefined();
  });

  it('falls back to the breakMinutes scalar when breakPeriods is null', () => {
    const r = formatBreakDisplay(null, 30);
    expect(r.text).toBe('30 min');
    expect(r.mismatchMinutes).toBeUndefined();
  });

  it('returns empty text (caller shows a "No break" label) when there is no break at all', () => {
    expect(formatBreakDisplay(null, 0).text).toBe('');
    expect(formatBreakDisplay(undefined, undefined).text).toBe('');
    expect(formatBreakDisplay([], 0).text).toBe('');
  });
});
