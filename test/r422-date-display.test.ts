/**
 * r422 (board 7e784380) — lib/date-display.ts, the ONE DD-MMM-YYYY formatter of the Personnel profile.
 *
 * The timezone half is the one that matters. `new Date('2026-01-31')` is UTC midnight; a host WEST of UTC
 * prints it as 30 Jan. So the whole file runs under TZ=America/Los_Angeles and first proves the trap is
 * armed here (the naive reading really does drift), then that formatDmy does not fall into it.
 */
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { DMY_EMPTY, formatDmy, formatDmyInText, formatDmyTime } from '../lib/date-display';

describe('r422 — formatDmy', () => {
  it('the timezone trap is armed in this file (a naive Date read drifts a day west of UTC)', () => {
    expect(new Date('2026-01-31T12:00:00Z').getTimezoneOffset(), 'running west of UTC').toBeGreaterThan(0);
    expect(new Date('2026-01-31').getDate(), 'the naive read lands on the 30th').toBe(30);
  });

  it('draws month ends as DD-MMM-YYYY with no drift', () => {
    expect(formatDmy('2026-01-31')).toBe('31-Jan-2026');
    expect(formatDmy('2026-02-28')).toBe('28-Feb-2026');
    expect(formatDmy('2026-03-31')).toBe('31-Mar-2026');
    expect(formatDmy('2026-04-30')).toBe('30-Apr-2026');
    expect(formatDmy('2026-06-30')).toBe('30-Jun-2026');
    expect(formatDmy('2026-09-30')).toBe('30-Sep-2026');
    expect(formatDmy('2026-12-31')).toBe('31-Dec-2026');
    expect(formatDmy('2026-10-08')).toBe('08-Oct-2026');
    expect(formatDmy('2027-01-01')).toBe('01-Jan-2027');
  });

  it('every month abbreviation is English', () => {
    const months = Array.from({ length: 12 }, (_, i) => formatDmy(`2026-${String(i + 1).padStart(2, '0')}-15`).slice(3, 6));
    expect(months).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });

  it('a leap day exists only in a leap year', () => {
    expect(formatDmy('2028-02-29')).toBe('29-Feb-2028');
    expect(formatDmy('2000-02-29')).toBe('29-Feb-2000');
    // Not real days: returned unchanged rather than rolled into March.
    expect(formatDmy('2026-02-29')).toBe('2026-02-29');
    expect(formatDmy('1900-02-29')).toBe('1900-02-29');
  });

  it('blank, null and undefined are the em dash', () => {
    expect(formatDmy(null)).toBe(DMY_EMPTY);
    expect(formatDmy(undefined)).toBe(DMY_EMPTY);
    expect(formatDmy('')).toBe(DMY_EMPTY);
    expect(formatDmy('   ')).toBe(DMY_EMPTY);
    expect(DMY_EMPTY).toBe('—');
  });

  it('malformed input comes back unchanged', () => {
    for (const bad of ['2026-13-01', '2026-00-10', '2026-04-31', '31/01/2026', 'Jan 31 2026', 'not a date', '2026-1-5', '20260131']) {
      expect(formatDmy(bad), bad).toBe(bad);
    }
  });

  it('a timestamp is drawn as its KUALA LUMPUR calendar day, not UTC and not the host’s', () => {
    // 2026-01-31 20:30 UTC is 1 Feb 04:30 in Kuala Lumpur (UTC+8) and still 31 Jan 12:30 in Los Angeles.
    expect(formatDmy('2026-01-31T20:30:00Z')).toBe('01-Feb-2026');
    expect(formatDmy(new Date('2026-01-31T20:30:00Z'))).toBe('01-Feb-2026');
    // 2026-01-31 15:59 UTC is 23:59 in KL: the same calendar day.
    expect(formatDmy('2026-01-31T15:59:00.000Z')).toBe('31-Jan-2026');
    expect(formatDmy(new Date('nonsense'))).toBe(DMY_EMPTY);
  });

  it('formatDmyTime reads date AND time off the same KL clock', () => {
    expect(formatDmyTime(new Date('2026-01-31T20:30:00Z'))).toBe('01-Feb-2026 04:30');
    expect(formatDmyTime('2026-07-10T01:32:00Z')).toBe('10-Jul-2026 09:32');
    expect(formatDmyTime('2026-07-10')).toBe('10-Jul-2026');
    expect(formatDmyTime(null)).toBe(DMY_EMPTY);
    expect(formatDmyTime('garbage')).toBe('garbage');
  });

  it('formatDmyInText redraws calendar dates inside a sentence and leaves timestamps alone', () => {
    expect(formatDmyInText('2026-01-01 → 2026-03-31')).toBe('01-Jan-2026 → 31-Mar-2026');
    expect(formatDmyInText('effective 2028-02-29, was 2026-02-30')).toBe('effective 29-Feb-2028, was 2026-02-30');
    expect(formatDmyInText('at 2026-01-31T20:30:00Z')).toBe('at 2026-01-31T20:30:00Z');
    expect(formatDmyInText('RM 5,000.00')).toBe('RM 5,000.00');
  });
});
