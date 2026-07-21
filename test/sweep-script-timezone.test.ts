/**
 * Guard for the UTC-vs-MYT date bug in the four out-of-band sweep scripts.
 *
 * All four (accrue-earned, review-sweep, expire-carry, expire-aged-leave) used to resolve "today" as
 * `new Date().toISOString().slice(0, 10)` — a UTC date. Every one of them is scheduled in the small
 * hours LOCAL time (02:00, 03:00, 03:30), and the deploy host runs UTC+8, so at those hours the UTC
 * date is still the PREVIOUS day. Concretely: the monthly accrual fires at 02:00 on the 1st and would
 * have computed an as-of date in the previous month, accruing against the wrong period; the annual
 * carry-forward expiry fires at 03:00 on 1 Apr and would have resolved to 31 Mar — ON the expiry date
 * rather than after it — forfeiting nothing for a whole year.
 *
 * The bug had never fired because nothing was ever scheduled on the server. These assertions exist so
 * it cannot come back when someone "simplifies" the date handling.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { todayInKualaLumpur } from '../core/leave';

const SCRIPTS = [
  'scripts/accrue-earned.ts',
  'scripts/review-sweep.ts',
  'scripts/expire-carry.ts',
  'scripts/expire-aged-leave.ts',
];

describe('sweep scripts resolve "today" in MYT, not UTC', () => {
  it.each(SCRIPTS)('%s uses todayInKualaLumpur and no raw toISOString date', (path) => {
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/todayInKualaLumpur\(\)/);
    // The exact shape of the bug: an ISO date sliced off a UTC timestamp.
    expect(src).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/);
  });

  // The boundary that makes this a real bug rather than a style preference. 2026-04-01T02:00+08:00 is
  // 2026-03-31T18:00Z — the UTC date is a day behind, and a month behind at a month boundary.
  it('resolves the local calendar day at the 02:00 MYT scheduling hour', () => {
    const at0200Myt = new Date('2026-04-01T02:00:00+08:00');
    expect(at0200Myt.toISOString().slice(0, 10)).toBe('2026-03-31'); // what the old code produced
    expect(todayInKualaLumpur(at0200Myt)).toBe('2026-04-01'); // what the schedule intends
  });

  it('crosses a month boundary correctly for the 1st-of-month accrual', () => {
    // 03:00 MYT on 1 July is still 30 June in UTC — the previous MONTH, not merely the previous day.
    const at0300Myt = new Date('2026-07-01T03:00:00+08:00');
    expect(at0300Myt.toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(todayInKualaLumpur(at0300Myt)).toBe('2026-07-01');
  });

  it('agrees with UTC during the working day, so only the scheduled hours were affected', () => {
    const midday = new Date('2026-07-01T12:00:00+08:00');
    expect(todayInKualaLumpur(midday)).toBe('2026-07-01');
    expect(midday.toISOString().slice(0, 10)).toBe('2026-07-01');
  });
});
