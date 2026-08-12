/**
 * computeClaimAmount + dateMinusDays — pure helpers for the claim-form enhancement (no DB).
 */
import { describe, expect, it } from 'vitest';
import { addMonthsClamped, claimBlockWindow, computeClaimAmount, dateMinusDays } from '../core/claims';

describe('computeClaimAmount', () => {
  it('mileage_flat: amount = km × ratePerKm', () => {
    expect(computeClaimAmount({ kind: 'mileage_flat', ratePerKm: 0.7 }, { quantityKm: 100 })).toBeCloseTo(70);
    expect(computeClaimAmount({ kind: 'mileage_flat', ratePerKm: 0.6 }, { quantityKm: 12.5 })).toBeCloseTo(7.5);
  });

  it('mileage_flat: rejects km that is null / 0 / negative', () => {
    expect(() => computeClaimAmount({ kind: 'mileage_flat', ratePerKm: 0.7 }, { quantityKm: null })).toThrow();
    expect(() => computeClaimAmount({ kind: 'mileage_flat', ratePerKm: 0.7 }, { quantityKm: 0 })).toThrow();
    expect(() => computeClaimAmount({ kind: 'mileage_flat', ratePerKm: 0.7 }, { quantityKm: -5 })).toThrow();
  });

  it('fixed_allowance: returns the config amount, ignoring any entered amount', () => {
    expect(computeClaimAmount({ kind: 'fixed_allowance', amount: 600 }, { enteredAmount: 0 })).toBe(600);
    expect(computeClaimAmount({ kind: 'fixed_allowance', amount: 600 }, { enteredAmount: 999 })).toBe(600);
  });

  it('receipt (or null/absent): passes through the entered amount', () => {
    expect(computeClaimAmount({ kind: 'receipt' }, { enteredAmount: 123.45 })).toBe(123.45);
    expect(computeClaimAmount(null, { enteredAmount: 50 })).toBe(50);
    expect(computeClaimAmount(undefined, { enteredAmount: 50 })).toBe(50);
  });
});

describe('dateMinusDays (UTC)', () => {
  it('subtracts whole days as UTC date strings', () => {
    expect(dateMinusDays('2026-06-26', 45)).toBe('2026-05-12');
    expect(dateMinusDays('2026-03-01', 1)).toBe('2026-02-28');
    expect(dateMinusDays('2026-01-01', 1)).toBe('2025-12-31');
  });
});

// ───────── PER BLOCK: the window arithmetic, with no database in sight (e7eb5d83 rev 4) ─────────
//
// These are the two functions the whole per-block limit rests on. Every DB test below them proves the
// SUM is filtered by the window; these prove the window is the right one. Kept pure and separate because
// a boundary that is one day out is invisible in an integration test that happens to use mid-month dates.

describe('addMonthsClamped', () => {
  it('adds whole months', () => {
    expect(addMonthsClamped('2026-01-01', 6)).toBe('2026-07-01');
    expect(addMonthsClamped('2026-01-01', 24)).toBe('2028-01-01');
    expect(addMonthsClamped('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('CLAMPS the day to the target month rather than rolling into the next one', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28'); // not 2026-03-03
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29'); // leap year
    expect(addMonthsClamped('2026-03-31', 1)).toBe('2026-04-30');
  });

  it('subtracts months, crossing a year boundary', () => {
    expect(addMonthsClamped('2026-02-15', -3)).toBe('2025-11-15');
    expect(addMonthsClamped('2026-01-01', -1)).toBe('2025-12-01');
  });
});

describe('claimBlockWindow', () => {
  const twoYears = { length: 2, unit: 'year' as const, limit: 2000, startOn: '2026-01-01' };
  const sixMonths = { length: 6, unit: 'month' as const, limit: 300, startOn: '2026-01-01' };

  it('the reporter’s own example: RM2,000 every 2 years from 1 Jan 2026', () => {
    expect(claimBlockWindow(twoYears, '2026-03-10')).toMatchObject({
      startOn: '2026-01-01',
      endOn: '2027-12-31',
      endOnExclusive: '2028-01-01',
      index: 0,
    });
    expect(claimBlockWindow(twoYears, '2027-12-31')).toMatchObject({ startOn: '2026-01-01', index: 0 });
    expect(claimBlockWindow(twoYears, '2028-06-01')).toMatchObject({
      startOn: '2028-01-01',
      endOn: '2029-12-31',
      index: 1,
    });
  });

  it('THE BOUNDARY DAY BELONGS TO THE NEW BLOCK (half-open windows, so no day is in two pots)', () => {
    expect(claimBlockWindow(twoYears, '2028-01-01')).toMatchObject({ startOn: '2028-01-01', index: 1 });
    expect(claimBlockWindow(sixMonths, '2026-07-01')).toMatchObject({ startOn: '2026-07-01', index: 1 });
    expect(claimBlockWindow(sixMonths, '2026-06-30')).toMatchObject({ startOn: '2026-01-01', index: 0 });
  });

  it('RM300 every 6 months splits the year in two', () => {
    expect(claimBlockWindow(sixMonths, '2026-01-01')).toMatchObject({ startOn: '2026-01-01', endOn: '2026-06-30' });
    expect(claimBlockWindow(sixMonths, '2026-12-31')).toMatchObject({ startOn: '2026-07-01', endOn: '2026-12-31' });
    expect(claimBlockWindow(sixMonths, '2027-01-01')).toMatchObject({ startOn: '2027-01-01', index: 2 });
  });

  it('returns null BEFORE the anchor — that claim is in no block at all', () => {
    expect(claimBlockWindow(twoYears, '2025-12-31')).toBeNull();
    expect(claimBlockWindow(sixMonths, '2020-01-01')).toBeNull();
  });

  it('a month-end anchor keeps its window boundaries stable across a short month', () => {
    const monthly = { length: 1, unit: 'month' as const, limit: 100, startOn: '2026-01-31' };
    // Jan 31 → Feb 28 (clamped) → Mar 31: the third window starts on the 31st again, NOT on the 28th.
    expect(claimBlockWindow(monthly, '2026-02-01')).toMatchObject({ startOn: '2026-01-31', index: 0 });
    expect(claimBlockWindow(monthly, '2026-02-28')).toMatchObject({ startOn: '2026-02-28', index: 1 });
    expect(claimBlockWindow(monthly, '2026-03-30')).toMatchObject({ startOn: '2026-02-28', index: 1 });
    expect(claimBlockWindow(monthly, '2026-03-31')).toMatchObject({ startOn: '2026-03-31', index: 2 });
  });
});
