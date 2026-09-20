/**
 * 845903a3 — ANNUAL LEAVE ENTITLEMENT PRORATION. The column headed as the year's allowance now shows THIS
 * employee's allowance for THIS leave year, prorated when they joined part way through it, rounded by a
 * rounding rule of its own.
 *
 * ⚠️ THE PREMISE THE PLAN SHIPPED WITH WAS WRONG, AND THE CORRECTION IS WHY THIS FILE EXISTS. The plan
 * told the reporter that the prorated figure was already on the screen as EARNED TO DATE, because for an
 * a2c first-year employee Annual Leave is granted as one up-front part-year amount. Measured on
 * production afterwards: the seeded `ANNUAL` type is ARCHIVED and the live one is `AL` ("*Annual Leave"),
 * and `isA2cFirstYear` matches the literal code 'ANNUAL' — so the up-front path never runs for the only
 * annual type the reporter uses. Their Earned to Date is the TO-DATE slice (confirmed against 6 of their
 * 2026 joiners: 4 match the to-date figure, 0 match the year-end one). The year's prorated allowance was
 * genuinely absent, so this is a new figure rather than a second rendering of an existing one.
 *
 * THAT IS ALSO WHY THE GATE IS THE ROLE. Keying on the code would have shipped a column that prorates
 * nothing on this tenant — the identical trap 65f466e2 fixed for the earned sweep ("a tenant's own Annual
 * Leave on a code the pack never seeded could never accrue a day"). `isEarnedAccrualType` asks
 * `leave_type.role` first. `isA2cFirstYear` itself is deliberately untouched: it decides how many days
 * people RECEIVE, and moving it to the role would move balances.
 *
 * WHAT THIS FILE PINS
 *   1. the arithmetic, including the reporter's own worked example and their 1 January case;
 *   2. that it is DISPLAY-ONLY — no ledger row, no grant, no movement in Earned to Date;
 *   3. that the two rounding rules are separate in both directions;
 *   4. that a type which is not the tenant's Annual Leave is never prorated (EA-1955 s.60F).
 */
import { describe, expect, it } from 'vitest';
import { displayEntitlementFor } from '../core/leave';

const AL = { role: 'annual', code: 'AL' };
const ANNUAL = { role: 'annual', code: 'ANNUAL' };
const SICK = { role: 'sick', code: 'SICK' };
const UNCLASSIFIED = { role: null, code: 'CGL' };

/** Round down to whole days, expressed the way the editor expresses it: one band over the whole decimal. */
const ROUND_DOWN = { method: 'custom', bands: [{ from: 0, to: 0.99, result: 0 }] };
const base = { annualEntitlementDays: 16, cycleStart: '2026-01-01', asOf: '2026-09-20' };

describe('845903a3 · the reporter’s worked example, to the decimal', () => {
  it('15 March 2026 on a 16 day entitlement gives 292/365 × 16 = 12.80', () => {
    const r = displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-03-15' });
    expect(r.prorated).toBe(true);
    expect(r.eligibleCalendarDays, '15 Mar to 31 Dec, both ends included').toBe(292);
    expect(r.daysInLeaveYear).toBe(365);
    expect(r.unroundedEntitlementDays).toBe(12.8);
    // No entitlement rounding configured ⇒ the exact figure stands. This is the deploy-day state for
    // every existing leave type, which is what makes the migration safe: nothing moves until HR says so.
    expect(r.displayEntitlementDays).toBe(12.8);
    expect(r.roundingApplied).toBe(false);
  });

  it('…and their round-down rule takes it to 12.00', () => {
    const r = displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-03-15', rounding: ROUND_DOWN });
    expect(r.unroundedEntitlementDays, 'the working is still the working').toBe(12.8);
    expect(r.displayEntitlementDays).toBe(12);
    expect(r.roundingApplied).toBe(true);
  });

  it('a 1 January joiner gets the whole allowance, and rounding does not touch it', () => {
    const r = displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-01-01', rounding: ROUND_DOWN });
    expect(r.prorated, 'joining on the first day is not joining part way through').toBe(false);
    expect(r.displayEntitlementDays).toBe(16);
  });

  it('somebody who joined in an EARLIER year sees the allowance untouched — the 51 the plan promised', () => {
    const r = displayEntitlementFor({ ...base, type: AL, hiredOn: '2024-07-01', rounding: ROUND_DOWN });
    expect(r.prorated).toBe(false);
    expect(r.annualEntitlementDays).toBe(16);
    expect(r.displayEntitlementDays, 'a display rule must not re-cut a figure HR configured').toBe(16);
  });

  /** The kernel's own clamp, kept because it is the reason a leap-year first year cannot overshoot. */
  it('never exceeds the annual entitlement, even across a leap year', () => {
    const r = displayEntitlementFor({
      ...base,
      type: AL,
      hiredOn: '2028-01-02',
      cycleStart: '2028-01-01',
      asOf: '2028-06-01',
    });
    expect(r.unroundedEntitlementDays).toBeLessThanOrEqual(16);
  });

  it('a first-year LEAVER is capped at their last working day, not 31 December', () => {
    const full = displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-03-15' });
    const left = displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-03-15', serviceEnd: '2026-06-30' });
    expect(left.eligibleCalendarDays).toBe(108); // 15 Mar to 30 Jun inclusive
    expect(left.unroundedEntitlementDays).toBeLessThan(full.unroundedEntitlementDays);
  });
});

describe('845903a3 · only the tenant’s Annual Leave prorates', () => {
  it('the LIVE type is matched by its ROLE, not by the seeded code', () => {
    // The whole feature on this tenant. AL carries role 'annual'; if this ever reads false the column
    // prorates nothing for the only annual type in use, and the item has shipped as a no-op.
    expect(displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-03-15' }).prorated).toBe(true);
  });

  it('the seeded code still works for a tenant who never classified their rows', () => {
    expect(displayEntitlementFor({ ...base, type: { role: null, code: 'ANNUAL' }, hiredOn: '2026-03-15' }).prorated).toBe(true);
    expect(displayEntitlementFor({ ...base, type: ANNUAL, hiredOn: '2026-03-15' }).prorated).toBe(true);
  });

  /**
   * STATUTORY, NOT STYLISTIC. Sick and hospitalisation leave are per-calendar-year entitlements under
   * EA-1955 s.60F and must reach a mid-year joiner IN FULL. Day-slicing them would understate a
   * statutory floor on the screen HR reads.
   */
  it('sick leave is NEVER prorated, however mid-year the joiner', () => {
    const r = displayEntitlementFor({ ...base, type: SICK, hiredOn: '2026-12-30' });
    expect(r.prorated).toBe(false);
    expect(r.displayEntitlementDays).toBe(16);
  });

  it('nor is an unclassified type that is not Annual Leave', () => {
    expect(displayEntitlementFor({ ...base, type: UNCLASSIFIED, hiredOn: '2026-03-15' }).prorated).toBe(false);
  });

  it('a type with no entitlement resolved stays an honest 0.00', () => {
    const r = displayEntitlementFor({ ...base, type: AL, annualEntitlementDays: 0, hiredOn: '2026-03-15' });
    expect(r.displayEntitlementDays).toBe(0);
    expect(r.prorated).toBe(false);
  });
});

describe('845903a3 · the two rounding rules are separate, in both directions', () => {
  it('the ENTITLEMENT rule is the only one this figure reads', () => {
    const r = displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-03-15', rounding: ROUND_DOWN });
    expect(r.displayEntitlementDays).toBe(12);
  });

  it('no rule configured ⇒ the exact prorated figure, never a silent default', () => {
    for (const rounding of [undefined, null, { method: null }, { method: 'none' }] as const) {
      const r = displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-03-15', rounding });
      expect(r.displayEntitlementDays, String(JSON.stringify(rounding))).toBe(12.8);
    }
  });

  /**
   * The reporter's requirement 7 from the other side: an EMPTY band table must not silently round to
   * zero. `applyRoundingBands` leaves a value no band covers alone, which is what a part-built table
   * has to do — the alternative is a screen quietly showing 0.00 while somebody is still typing.
   */
  it('a half-built table leaves an uncovered figure alone', () => {
    const r = displayEntitlementFor({
      ...base,
      type: AL,
      hiredOn: '2026-03-15',
      rounding: { method: 'custom', bands: [{ from: 0, to: 0.5, result: 0 }] },
    });
    expect(r.displayEntitlementDays, '0.80 is covered by no band').toBe(12.8);
  });

  it('the rule can round UP as easily as down — nothing is hard-coded', () => {
    const r = displayEntitlementFor({
      ...base,
      type: AL,
      hiredOn: '2026-03-15',
      rounding: { method: 'custom', bands: [{ from: 0, to: 0.99, result: 1 }] },
    });
    expect(r.displayEntitlementDays).toBe(13);
  });

  it('and to half days, which is what this tenant already uses for accrual', () => {
    const r = displayEntitlementFor({
      ...base,
      type: AL,
      hiredOn: '2026-03-15',
      rounding: { method: 'custom', bands: [{ from: 0.69, to: 0.99, result: 0.5 }] },
    });
    expect(r.displayEntitlementDays).toBe(12.5);
  });
});

describe('845903a3 · it is display-only, which is the promise that must not break', () => {
  /**
   * The reporter forbade any change to Earned to Date twice, in their own words. The structural proof is
   * that this function is PURE: it takes figures and returns figures. It has no transaction, no context
   * and no database handle, so there is no code path by which it could write a ledger row — and the
   * entitlement rounding columns are deliberately outside `leaveTypeRuleColumns`, the map the granting
   * engines and the projection kernel read.
   */
  it('returns the same answer however many times it is asked', () => {
    const args = { ...base, type: AL, hiredOn: '2026-03-15', rounding: ROUND_DOWN } as const;
    const a = displayEntitlementFor(args);
    const b = displayEntitlementFor(args);
    expect(a).toEqual(b);
  });

  it('keeps the annual figure it was handed, so the band is still readable beside the result', () => {
    const r = displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-03-15', rounding: ROUND_DOWN });
    expect(r.annualEntitlementDays, 'the table figure is not overwritten by the prorated one').toBe(16);
    expect(r.displayEntitlementDays).toBe(12);
  });

  it('a pre-hire as-at date shows nothing rather than a negative or a full year', () => {
    const r = displayEntitlementFor({ ...base, type: AL, hiredOn: '2026-03-15', asOf: '2026-01-05' });
    expect(r.unroundedEntitlementDays).toBe(0);
    expect(r.displayEntitlementDays).toBe(0);
  });
});
