/**
 * computeClaimAmount + dateMinusDays — pure helpers for the claim-form enhancement (no DB).
 */
import { describe, expect, it } from 'vitest';
import { computeClaimAmount, dateMinusDays } from '../core/claims';

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
