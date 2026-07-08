/**
 * c7fdfcf6 — Payroll Schedule cut-off windows (pure, no DB). Proves:
 *  A) cleanPayrollPolicyConfig persists per-type overrides + frequency, and drops no-op values (byte-identical).
 *  B) cutOffWindowFor resolves the window via the policy-perType → policy-anchor → company-column → calendar
 *     chain, is cross-month + leap-year safe, and returns the EXACT calendar month when nothing is configured.
 *  C) Windows are contiguous + non-overlapping across consecutive periods (the "no overlap/gap" guarantee).
 */
import { describe, expect, it } from 'vitest';
import {
  anchorWindowFor,
  calendarWindowFor,
  cleanPayrollPolicyConfig,
  cutOffWindowFor,
  hasCustomCutOff,
  payrollFrequencyOf,
  type CompanyCutOffConfig,
} from '../core/payroll-policy-config';
import type { PayrollPolicyConfig } from '../db/schema';

describe('c7fdfcf6 · cleanPayrollPolicyConfig — per-type cut-off + frequency', () => {
  it('drops a monthly frequency + calendar cut-off to null (byte-identical to today)', () => {
    expect(cleanPayrollPolicyConfig({ frequency: 'monthly', cutOff: { mode: 'calendar' } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ frequency: 'bogus' })).toBeNull();
  });

  it('persists a non-default frequency', () => {
    expect(cleanPayrollPolicyConfig({ frequency: 'weekly' })).toEqual({ frequency: 'weekly' });
    expect(cleanPayrollPolicyConfig({ frequency: 'biweekly' })).toEqual({ frequency: 'biweekly' });
  });

  it('persists a custom base anchor and per-type overrides, clamping to 1..28', () => {
    const c = cleanPayrollPolicyConfig({
      cutOff: { mode: 'custom', anchorDay: 26, perType: { claim: 20, overtime: 99, leave: 26, attendance: 15 } },
    });
    // overtime 99 is out of range ⇒ dropped; leave 26 equals the base ⇒ dropped (would resolve to same window).
    expect(c).toEqual({ cutOff: { mode: 'custom', anchorDay: 26, perType: { claim: 20, attendance: 15 } } });
  });

  it('drops perType entirely when every type equals the base anchor', () => {
    expect(
      cleanPayrollPolicyConfig({ cutOff: { mode: 'custom', anchorDay: 10, perType: { claim: 10, overtime: 10 } } }),
    ).toEqual({ cutOff: { mode: 'custom', anchorDay: 10 } });
  });

  it('a custom mode without a valid anchor day collapses to null (calendar default)', () => {
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom' } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom', anchorDay: 40 } })).toBeNull();
  });
});

describe('c7fdfcf6 · anchorWindowFor / calendarWindowFor', () => {
  it('calendar window = exact month bounds (incl. leap Feb)', () => {
    expect(calendarWindowFor('2026-05')).toEqual({ start: '2026-05-01', end: '2026-05-31' });
    expect(calendarWindowFor('2024-02')).toEqual({ start: '2024-02-01', end: '2024-02-29' }); // leap
    expect(calendarWindowFor('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('anchor 26 ⇒ [26 of M-1 … 25 of M]', () => {
    expect(anchorWindowFor('2026-05', 26)).toEqual({ start: '2026-04-26', end: '2026-05-25' });
  });

  it('anchor 1 ⇒ the whole previous month', () => {
    expect(anchorWindowFor('2026-03', 1)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('crosses the year boundary (January period)', () => {
    expect(anchorWindowFor('2026-01', 26)).toEqual({ start: '2025-12-26', end: '2026-01-25' });
  });

  it('clamps an anchor > 28 to 28', () => {
    expect(anchorWindowFor('2026-05', 31)).toEqual({ start: '2026-04-28', end: '2026-05-27' });
  });
});

describe('c7fdfcf6 · cutOffWindowFor — resolution chain', () => {
  const period = '2026-05';
  const cal = { start: '2026-05-01', end: '2026-05-31' };

  it('nothing configured ⇒ exact calendar month for every type (byte-identical)', () => {
    for (const t of ['salary', 'claim', 'overtime', 'leave', 'attendance'] as const) {
      expect(cutOffWindowFor(t, null, null, period)).toEqual(cal);
      expect(hasCustomCutOff(t, null, null, period)).toBe(false);
    }
  });

  it('policy base anchor drives every type; per-type overrides win where set', () => {
    const cfg: PayrollPolicyConfig = {
      cutOff: { mode: 'custom', anchorDay: 26, perType: { overtime: 21, attendance: 16 } },
    };
    // salary + claim + leave inherit the base 26 ⇒ [26 Apr … 25 May]
    expect(cutOffWindowFor('salary', cfg, null, period)).toEqual({ start: '2026-04-26', end: '2026-05-25' });
    expect(cutOffWindowFor('claim', cfg, null, period)).toEqual({ start: '2026-04-26', end: '2026-05-25' });
    expect(cutOffWindowFor('leave', cfg, null, period)).toEqual({ start: '2026-04-26', end: '2026-05-25' });
    // overtime + attendance use their own anchors
    expect(cutOffWindowFor('overtime', cfg, null, period)).toEqual({ start: '2026-04-21', end: '2026-05-20' });
    expect(cutOffWindowFor('attendance', cfg, null, period)).toEqual({ start: '2026-04-16', end: '2026-05-15' });
  });

  it('falls back to the company-level column when the policy has no custom cut-off', () => {
    const company: CompanyCutOffConfig = {
      cutOffDay: 25,
      overtimeCutOffDay: 20,
      claimCutOffDay: null,
      unpaidLeaveCutOffDay: 15,
      attendanceCutOffDay: null,
    };
    expect(cutOffWindowFor('salary', null, company, period)).toEqual({ start: '2026-04-25', end: '2026-05-24' });
    expect(cutOffWindowFor('overtime', null, company, period)).toEqual({ start: '2026-04-20', end: '2026-05-19' });
    expect(cutOffWindowFor('leave', null, company, period)).toEqual({ start: '2026-04-15', end: '2026-05-14' });
    // no claim/attendance company column ⇒ calendar month
    expect(cutOffWindowFor('claim', null, company, period)).toEqual(cal);
    expect(cutOffWindowFor('attendance', null, company, period)).toEqual(cal);
  });

  it('a policy custom cut-off wins over the company column', () => {
    const cfg: PayrollPolicyConfig = { cutOff: { mode: 'custom', anchorDay: 10 } };
    const company: CompanyCutOffConfig = { cutOffDay: 25 };
    expect(cutOffWindowFor('salary', cfg, company, period)).toEqual({ start: '2026-04-10', end: '2026-05-09' });
  });
});

describe('c7fdfcf6 · contiguity — consecutive windows never overlap or gap', () => {
  it('period N end +1 day == period N+1 start, for anchor 26 across a year boundary', () => {
    const apr = cutOffWindowFor('salary', { cutOff: { mode: 'custom', anchorDay: 26 } }, null, '2025-12');
    const may = cutOffWindowFor('salary', { cutOff: { mode: 'custom', anchorDay: 26 } }, null, '2026-01');
    const nextDay = new Date(Date.parse(`${apr.end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(nextDay).toBe(may.start);
  });
});

describe('c7fdfcf6 · payrollFrequencyOf', () => {
  it('defaults to monthly, reads the stored value', () => {
    expect(payrollFrequencyOf(null)).toBe('monthly');
    expect(payrollFrequencyOf({ frequency: 'weekly' })).toBe('weekly');
  });
});
