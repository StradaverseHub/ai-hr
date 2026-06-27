/**
 * 1.2.8 loan calc engine (ADR-0060) — pure unit tests for the instalment + schedule math (integer cents).
 * Covers: flat add-on interest, none (interest-free), last-instalment reconciliation summing byte-exact,
 * and edge cases (1-month duration, 0% interest).
 */
import { describe, expect, it } from 'vitest';
import { computeLoan } from '../core/loans';

const cents = (n: number) => Math.round(n * 100);

describe('ADR-0060 — loan calc engine', () => {
  it("method='none': instalment = principal / months, schedule sums to principal exactly", () => {
    const r = computeLoan({ principal: 1200, annualInterestPct: 5, durationMonths: 12, method: 'none' });
    expect(r.totalRepayableCents).toBe(cents(1200)); // no interest under 'none' even if a rate is supplied
    expect(r.monthlyInstalmentCents).toBe(cents(100));
    expect(r.schedule).toHaveLength(12);
    expect(r.schedule.reduce((s, c) => s + c, 0)).toBe(r.totalRepayableCents);
  });

  it("method='flat': add-on interest on the original principal", () => {
    // 12000 principal, 6% p.a. flat, 24 months → interest = 12000 × 0.06 × 2 = 1440 → total 13440.
    const r = computeLoan({ principal: 12000, annualInterestPct: 6, durationMonths: 24, method: 'flat' });
    expect(r.totalRepayableCents).toBe(cents(13440));
    expect(r.monthlyInstalmentCents).toBe(cents(560)); // 13440 / 24 = 560 exactly
    expect(r.schedule.reduce((s, c) => s + c, 0)).toBe(r.totalRepayableCents);
  });

  it('last-instalment reconciliation: an indivisible total still sums byte-exact', () => {
    // 1000 / 3 = 333.33… → instalment rounds, final reconciles.
    const r = computeLoan({ principal: 1000, annualInterestPct: 0, durationMonths: 3, method: 'none' });
    expect(r.totalRepayableCents).toBe(cents(1000));
    expect(r.schedule).toHaveLength(3);
    expect(r.schedule.reduce((s, c) => s + c, 0)).toBe(cents(1000));
    // The first (durationMonths-1) are the equal instalment; the final reconciles the remainder.
    expect(r.schedule[0]).toBe(r.monthlyInstalmentCents);
    expect(r.schedule[1]).toBe(r.monthlyInstalmentCents);
  });

  it('edge: 1-month duration → single instalment equal to the total', () => {
    const r = computeLoan({ principal: 500, annualInterestPct: 10, durationMonths: 1, method: 'flat' });
    // interest = 500 × 0.10 × (1/12) = 4.1666… → rounds to 4.17 → total 504.17
    expect(r.totalRepayableCents).toBe(cents(504.17));
    expect(r.schedule).toHaveLength(1);
    expect(r.schedule[0]).toBe(r.totalRepayableCents);
    expect(r.monthlyInstalmentCents).toBe(r.totalRepayableCents);
  });

  it('edge: 0% interest under flat behaves like none', () => {
    const r = computeLoan({ principal: 600, annualInterestPct: 0, durationMonths: 6, method: 'flat' });
    expect(r.totalRepayableCents).toBe(cents(600));
    expect(r.monthlyInstalmentCents).toBe(cents(100));
    expect(r.schedule.reduce((s, c) => s + c, 0)).toBe(cents(600));
  });

  it('rejects invalid inputs', () => {
    expect(() => computeLoan({ principal: 0, annualInterestPct: 0, durationMonths: 6, method: 'none' })).toThrow();
    expect(() => computeLoan({ principal: 100, annualInterestPct: 0, durationMonths: 0, method: 'none' })).toThrow();
    expect(() => computeLoan({ principal: 100, annualInterestPct: -1, durationMonths: 6, method: 'none' })).toThrow();
  });
});
