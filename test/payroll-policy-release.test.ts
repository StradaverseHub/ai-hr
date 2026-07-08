/**
 * f3148da1 — pure-unit coverage for the three new payroll-policy primitives (no DB):
 *   • cleanPayslipRelease        — Step 6 config validation/clamp (immediate/fixed_day/relative)
 *   • payslipReleaseAt           — Step 6 release-instant derivation (never before close; legacy null = released)
 *   • applyOvertimeCapsDetailed  — Step 4 excess measurement (excess = preCap − capped)
 *   • cleanPayrollPolicyConfig   — Step 4 overtime.exceedHandling persistence (convert only with a UUID)
 */
import { describe, expect, it } from 'vitest';
import {
  applyOvertimeCapsDetailed,
  cleanPayrollPolicyConfig,
  cleanPayslipRelease,
  payslipReleaseAt,
} from '../core/payroll-policy-config';

describe('f3148da1 cleanPayslipRelease', () => {
  it('null / empty / immediate ⇒ null (today’s behaviour)', () => {
    expect(cleanPayslipRelease(null)).toBeNull();
    expect(cleanPayslipRelease({})).toBeNull();
    expect(cleanPayslipRelease({ mode: 'immediate' })).toBeNull();
    expect(cleanPayslipRelease({ mode: 'bogus' })).toBeNull();
  });
  it('fixed_day requires a valid day (1..31)', () => {
    expect(cleanPayslipRelease({ mode: 'fixed_day', day: 25 })).toEqual({ mode: 'fixed_day', day: 25 });
    expect(cleanPayslipRelease({ mode: 'fixed_day' })).toBeNull();
    expect(cleanPayslipRelease({ mode: 'fixed_day', day: 40 })).toBeNull();
  });
  it('relative clamps offsetDays to [-15,15]', () => {
    expect(cleanPayslipRelease({ mode: 'relative', offsetDays: 3 })).toEqual({ mode: 'relative', offsetDays: 3 });
    expect(cleanPayslipRelease({ mode: 'relative', offsetDays: -2 })).toEqual({ mode: 'relative', offsetDays: -2 });
    expect(cleanPayslipRelease({ mode: 'relative', offsetDays: 99 })).toEqual({ mode: 'relative', offsetDays: 15 });
    expect(cleanPayslipRelease({ mode: 'relative' })).toBeNull();
  });
});

describe('f3148da1 payslipReleaseAt', () => {
  const closed = new Date('2026-02-05T09:00:00.000Z'); // batch closed 5 Feb for the 2026-01 period

  it('null closedAt ⇒ null (legacy batch = released)', () => {
    expect(payslipReleaseAt(null, '2026-01', 25, { mode: 'fixed_day', day: 25 })).toBeNull();
  });
  it('immediate / null cfg ⇒ closedAt', () => {
    expect(payslipReleaseAt(closed, '2026-01', 25, null)?.getTime()).toBe(closed.getTime());
    expect(payslipReleaseAt(closed, '2026-01', 25, { mode: 'immediate' })?.getTime()).toBe(closed.getTime());
  });
  it('fixed_day ⇒ that day of the month AFTER the pay period', () => {
    // 2026-01 period ⇒ pay month Feb; day 25 ⇒ 25 Feb 2026, which is after the 5 Feb close ⇒ that date.
    const r = payslipReleaseAt(closed, '2026-01', null, { mode: 'fixed_day', day: 25 });
    expect(r?.toISOString().slice(0, 10)).toBe('2026-02-25');
  });
  it('fixed_day before close is clamped to closedAt (never before close)', () => {
    // day 1 ⇒ 1 Feb, which is BEFORE the 5 Feb close ⇒ result is the close instant.
    const r = payslipReleaseAt(closed, '2026-01', null, { mode: 'fixed_day', day: 1 });
    expect(r?.getTime()).toBe(closed.getTime());
  });
  it('relative offsets the company pay-day anchor', () => {
    // payDay 28 (Feb) + offset -2 ⇒ 26 Feb 2026.
    const r = payslipReleaseAt(closed, '2026-01', 28, { mode: 'relative', offsetDays: -2 });
    expect(r?.toISOString().slice(0, 10)).toBe('2026-02-26');
  });
  it('relative with month-end anchor + December period rolls into next year', () => {
    const dec = new Date('2026-01-03T00:00:00.000Z');
    // 2025-12 period ⇒ pay month Jan 2026; null payDay ⇒ month-end (31 Jan); offset 0.
    const r = payslipReleaseAt(dec, '2025-12', null, { mode: 'relative', offsetDays: 0 });
    expect(r?.toISOString().slice(0, 10)).toBe('2026-01-31');
  });
});

describe('f3148da1 applyOvertimeCapsDetailed — excess', () => {
  it('no config ⇒ excess 0, capped == preCap', () => {
    const r = applyOvertimeCapsDetailed(null, { workday: 300, restDay: 0, holiday: 0, workedOtHours: 0 });
    expect(r).toEqual({ capped: 300, preCap: 300, excess: 0 });
  });
  it('maxAmount cap ⇒ excess = preCap − cap', () => {
    const cfg = cleanPayrollPolicyConfig({ overtime: { maxAmount: 200 } });
    const r = applyOvertimeCapsDetailed(cfg, { workday: 300, restDay: 0, holiday: 0, workedOtHours: 0 });
    expect(r.capped).toBeCloseTo(200, 2);
    expect(r.excess).toBeCloseTo(100, 2);
  });
});

describe('f3148da1 cleanPayrollPolicyConfig — overtime.exceedHandling', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  it('persists convert only with a valid UUID componentId', () => {
    const ok = cleanPayrollPolicyConfig({ overtime: { maxAmount: 200, exceedHandling: { action: 'convert', componentId: uuid } } });
    expect(ok?.overtime?.exceedHandling).toEqual({ action: 'convert', componentId: uuid });
  });
  it('drops convert with a missing/invalid componentId', () => {
    const bad = cleanPayrollPolicyConfig({ overtime: { maxAmount: 200, exceedHandling: { action: 'convert', componentId: 'not-a-uuid' } } });
    expect(bad?.overtime?.exceedHandling).toBeUndefined();
    const none = cleanPayrollPolicyConfig({ overtime: { maxAmount: 200, exceedHandling: { action: 'convert' } } });
    expect(none?.overtime?.exceedHandling).toBeUndefined();
  });
});
