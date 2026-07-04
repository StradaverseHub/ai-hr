/**
 * Unit test for the Attendance Policy shift summary table's Break Time formatter
 * (Configurable Multi-Shift Attendance Management). Pure function, no DB — covers the four cases the plan
 * calls out: multi-break array present, empty array, null/absent (falls back to breakMinutes), and the
 * mismatch case (breakPeriods present but their sum disagrees with the canonical breakMinutes scalar).
 */
import { describe, expect, it } from 'vitest';
import { formatBreakDisplay } from '../core/shift-break-display';

describe('formatBreakDisplay', () => {
  it('renders a single break window as HH:MM–HH:MM', () => {
    const r = formatBreakDisplay([{ start: '12:00:00', end: '13:00:00' }], 60);
    expect(r.text).toBe('12:00–13:00');
    expect(r.mismatchMinutes).toBeUndefined();
  });

  it('renders multiple break windows comma-separated, in order', () => {
    const r = formatBreakDisplay(
      [
        { start: '12:00', end: '13:00' },
        { start: '15:00', end: '15:15' },
      ],
      75,
    );
    expect(r.text).toBe('12:00–13:00, 15:00–15:15');
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
    expect(r.text).toBe('12:00–13:00, 15:00–15:15');
    expect(r.mismatchMinutes).toBe(60);
  });

  it('falls back to the breakMinutes scalar when there are no break windows (empty array)', () => {
    const r = formatBreakDisplay([], 45);
    expect(r.text).toBe('45 min');
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
