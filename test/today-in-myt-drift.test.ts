/**
 * Tree-wide guard for the UTC-vs-MYT "what date is NOW" bug (item bb4f2265).
 *
 * `new Date().toISOString().slice(0, 10)` is a UTC date. This product runs at UTC+8, so between 00:00
 * and 08:00 MYT it names YESTERDAY. r85 found the first live instance on core/movement.ts entryDate; it
 * had passed three green gates because the suite had only ever run during the Malaysian working day, and
 * failed the first time a run happened at 01:46. test/sweep-script-timezone.test.ts pins the four
 * out-of-band scripts; this pins everything else.
 *
 * THE DISTINCTION THIS GUARD IS BUILT AROUND, and the reason it matches only the ARGLESS form:
 *   - `new Date().toISOString().slice(0, 10)`  — "what date is this INSTANT". Depends on the clock, so
 *     it must go through the tenant timezone. THIS is the bug, and it is what the guard forbids.
 *   - `new Date(iso).toISOString().slice(0, 10)`, `Date.parse(...) + n * DAY_MS` — date-only ARITHMETIC.
 *     Correct in UTC and MUST stay UTC; changing it introduces bugs rather than fixing them. 51 such
 *     sites exist and none of them match the pattern below.
 *
 * Scoped deliberately narrowly: r86 lost four integration runs to over-broad source guards. The regex
 * requires literally empty parentheses, so no legitimate arithmetic form can trip it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timeInKualaLumpur, todayInKualaLumpur } from '../lib/hr-date';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCANNED = ['core', 'app', 'lib', 'packs', 'localization', 'components'];

/** The exact shape of the bug: an ISO date sliced off a timestamp taken from the clock RIGHT NOW. */
const ARGLESS_NOW_DATE = /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next') sourceFiles(rel, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(rel);
    }
  }
  return out;
}

describe('"today" is resolved in MYT, never off a UTC timestamp', () => {
  it('no application source takes the current date off toISOString()', () => {
    const offenders = SCANNED.flatMap((d) => sourceFiles(d)).filter((rel) =>
      ARGLESS_NOW_DATE.test(readFileSync(join(root, rel), 'utf8')),
    );
    // Named individually so a reintroduction points at its own file rather than a bare count.
    expect(offenders).toEqual([]);
  });

  // The boundary that makes this a real bug rather than a style preference. Without an INJECTED instant
  // these assertions would pass all afternoon and prove nothing — which is exactly how the first
  // instance survived three green gates.
  const justAfterLocalMidnight = new Date('2026-07-31T16:30:00Z'); // 2026-08-01T00:30 MYT

  it('resolves the MYT date, not the UTC one, inside the 00:00-08:00 window', () => {
    expect(todayInKualaLumpur(justAfterLocalMidnight)).toBe('2026-08-01');
    expect(justAfterLocalMidnight.toISOString().slice(0, 10)).toBe('2026-07-31'); // the old behaviour
  });

  it('holds at the month boundary, where the old behaviour slipped a whole month', () => {
    const firstOfMonth = new Date('2026-07-31T17:00:00Z'); // 2026-08-01T01:00 MYT
    expect(todayInKualaLumpur(firstOfMonth)).toBe('2026-08-01');
  });

  it('agrees with UTC once the local day is past 08:00', () => {
    const midMorning = new Date('2026-08-01T02:00:00Z'); // 2026-08-01T10:00 MYT
    expect(todayInKualaLumpur(midMorning)).toBe('2026-08-01');
    expect(midMorning.toISOString().slice(0, 10)).toBe('2026-08-01');
  });

  it('reads the clock time in MYT as zero-padded 24-hour HH:mm', () => {
    expect(timeInKualaLumpur(justAfterLocalMidnight)).toBe('00:30');
    expect(timeInKualaLumpur(new Date('2026-08-01T02:00:00Z'))).toBe('10:00');
  });

  // A punch stamped with a UTC date and a host-local time disagrees with itself for those eight hours:
  // yesterday's date beside today's time. Both halves must come off the same clock.
  it.each(['app/attendance/clock/actions.ts', 'app/me/actions.ts'])(
    '%s stamps a punch date and time from the same MYT clock',
    (rel) => {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).toMatch(/date: todayInKualaLumpur\(d\), time: timeInKualaLumpur\(d\)/);
      expect(src).not.toMatch(/toTimeString\(\)/);
    },
  );
});
