/**
 * fc88ba08 — a completed review's DECISION DATE read back as the previous day before 08:00 MYT.
 *
 * THE FAMILY THIS CLOSES. `core/employment-review.ts` derived a date from an instant in UTC:
 *
 *   const decidedOn = (row.decidedAt ?? row.createdAt).toISOString().slice(0, 10);
 *
 * Malaysia is UTC+8, so from midnight to 08:00 local the UTC date is still yesterday's. This is the
 * THIRD instance of one bug: r299 fixed `approvedOn` in core/toil.ts, r324 fixed `requestedOn` at two
 * sites in core/attendance.ts (where it was stamping a leave credit's Request Date a day early beside an
 * expiry resolved correctly in KL). This one is display-only, which is why r324 raised it rather than
 * folding an untested fix into an unrelated round.
 *
 * ⚠️ WHY THIS TEST HAS TO PIN THE TIMEZONE AND NOT JUST "A DATE". The existing tests for this path
 * passed either way — they compared the read against a value derived the SAME wrong way, so the two
 * agreed for sixteen hours out of twenty-four. That is exactly how all three instances survived. Every
 * case here therefore uses an instant whose UTC date and KL date DIFFER, so a regression to
 * `.toISOString()` fails at any hour rather than only before breakfast.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { todayInKualaLumpur } from '../lib/hr-date';

const SRC = readFileSync(join(__dirname, '..', 'core/employment-review.ts'), 'utf8');

/** 2026-09-21T17:07:00Z is 2026-09-22 01:07 in Kuala Lumpur — the window the bug lives in. */
const BEFORE_BREAKFAST = new Date('2026-09-21T17:07:00.000Z');
/** …and one safely inside the same day in both zones, so the fix cannot be "always add a day". */
const MIDDAY = new Date('2026-09-22T04:00:00.000Z');

describe('fc88ba08 · the decision date is the Malaysian one', () => {
  it('an instant before 08:00 MYT resolves to the LOCAL day, not the UTC one', () => {
    expect(todayInKualaLumpur(BEFORE_BREAKFAST), 'KL has already turned over').toBe('2026-09-22');
    // The old expression, kept here as the thing that must never come back.
    expect(BEFORE_BREAKFAST.toISOString().slice(0, 10), 'UTC has not').toBe('2026-09-21');
  });

  it('and an ordinary instant is unchanged — the fix is not "add a day"', () => {
    expect(todayInKualaLumpur(MIDDAY)).toBe('2026-09-22');
    expect(MIDDAY.toISOString().slice(0, 10)).toBe('2026-09-22');
  });

  it('the source resolves decidedOn through the KL helper', () => {
    expect(SRC).toContain('const decidedOn = todayInKualaLumpur(row.decidedAt ?? row.createdAt);');
  });

  /**
   * THE REGRESSION ARM, and the one that would have caught all three instances. No date in this file
   * may be derived from an instant in UTC again.
   */
  it('no date in the file is derived from an instant in UTC', () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    // Calendar arithmetic on a Z-anchored midnight is fine and stays — it carries no timezone. What is
    // refused is `<something>At.toISOString()`, a stored instant turned into a day.
    expect(code, 'a stored instant must not become a date in UTC').not.toMatch(
      /\b\w*(?:At|On)\b[^;\n]*\.toISOString\(\)\.slice\(0, 10\)/,
    );
  });
});
