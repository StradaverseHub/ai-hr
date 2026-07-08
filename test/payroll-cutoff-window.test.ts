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
  disburseNetAcrossCycles,
  hasCustomCutOff,
  payrollFrequencyOf,
  payrollScheduleFor,
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

describe('c7fdfcf6 gap-fix · per-frequency cut-off config', () => {
  it('persists per-frequency overrides, dropping blocks that equal the base anchor', () => {
    const c = cleanPayrollPolicyConfig({
      frequency: 'weekly',
      cutOff: {
        mode: 'custom',
        anchorDay: 26,
        perFrequency: {
          weekly: { anchorDay: 20, perType: { overtime: 18 } },
          biweekly: { anchorDay: 26, perType: { claim: 26 } }, // all == base ⇒ dropped
        },
      },
    });
    expect(c).toEqual({
      frequency: 'weekly',
      cutOff: { mode: 'custom', anchorDay: 26, perFrequency: { weekly: { anchorDay: 20, perType: { overtime: 18 } } } },
    });
  });

  it('a per-frequency block with only per-type overrides (no own anchor) is kept', () => {
    const c = cleanPayrollPolicyConfig({
      cutOff: { mode: 'custom', anchorDay: 26, perFrequency: { biweekly: { perType: { leave: 10 } } } },
    });
    expect(c).toEqual({
      cutOff: { mode: 'custom', anchorDay: 26, perFrequency: { biweekly: { perType: { leave: 10 } } } },
    });
  });

  it('cutOffWindowFor prefers the active frequency block over the base anchor', () => {
    const period = '2026-05';
    const cfg = {
      frequency: 'weekly' as const,
      cutOff: { mode: 'custom' as const, anchorDay: 26, perFrequency: { weekly: { anchorDay: 20, perType: { overtime: 15 } } } },
    };
    // salary follows the weekly anchor 20; overtime follows the weekly per-type 15.
    expect(cutOffWindowFor('salary', cfg, null, period)).toEqual({ start: '2026-04-20', end: '2026-05-19' });
    expect(cutOffWindowFor('overtime', cfg, null, period)).toEqual({ start: '2026-04-15', end: '2026-05-14' });
    // A monthly config ignores the weekly block entirely (falls back to the base anchor 26).
    const monthly = { ...cfg, frequency: 'monthly' as const };
    expect(cutOffWindowFor('salary', monthly, null, period)).toEqual({ start: '2026-04-26', end: '2026-05-25' });
  });
});

describe('c7fdfcf6 gap-fix · payrollScheduleFor — frequency generates cut-off cycles', () => {
  it('monthly ⇒ one cycle spanning the (calendar) month', () => {
    expect(payrollScheduleFor(null, null, '2026-05')).toEqual({
      frequency: 'monthly',
      periods: [{ seq: 1, start: '2026-05-01', end: '2026-05-31' }],
    });
  });

  it('weekly ⇒ contiguous 7-day cycles tiling the calendar month (last may be short)', () => {
    const s = payrollScheduleFor({ frequency: 'weekly' }, null, '2026-05'); // May has 31 days
    expect(s.frequency).toBe('weekly');
    expect(s.periods).toEqual([
      { seq: 1, start: '2026-05-01', end: '2026-05-07' },
      { seq: 2, start: '2026-05-08', end: '2026-05-14' },
      { seq: 3, start: '2026-05-15', end: '2026-05-21' },
      { seq: 4, start: '2026-05-22', end: '2026-05-28' },
      { seq: 5, start: '2026-05-29', end: '2026-05-31' },
    ]);
    // Cycles are contiguous + non-overlapping and their union == the whole month.
    for (let i = 1; i < s.periods.length; i++) {
      const nextDay = new Date(Date.parse(`${s.periods[i - 1].end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(nextDay).toBe(s.periods[i].start);
    }
    expect(s.periods[0].start).toBe('2026-05-01');
    expect(s.periods[s.periods.length - 1].end).toBe('2026-05-31');
  });

  it('biweekly ⇒ 14-day cycles', () => {
    const s = payrollScheduleFor({ frequency: 'biweekly' }, null, '2026-02'); // Feb 2026 has 28 days
    expect(s.periods).toEqual([
      { seq: 1, start: '2026-02-01', end: '2026-02-14' },
      { seq: 2, start: '2026-02-15', end: '2026-02-28' },
    ]);
  });

  it('weekly cycles follow a custom anchor window, not the calendar month', () => {
    const s = payrollScheduleFor(
      { frequency: 'weekly', cutOff: { mode: 'custom', anchorDay: 26 } },
      null,
      '2026-05',
    );
    // Salary window for anchor 26 = [26 Apr … 25 May]; first weekly cycle opens on the window start.
    expect(s.periods[0].start).toBe('2026-04-26');
    expect(s.periods[s.periods.length - 1].end).toBe('2026-05-25');
  });
});

describe('c7fdfcf6 gap-fix · disburseNetAcrossCycles — functional weekly/bi-weekly per-cycle disbursement', () => {
  it('monthly (one cycle) ⇒ the whole net on the single cycle', () => {
    expect(disburseNetAcrossCycles({ net: 3200, recurring: 3200, overtime: 0, unpaid: 0, cycleDays: [31], otMinutes: [0], unpaidDays: [0] })).toEqual([3200]);
  });

  it('four equal 7-day weekly cycles of a flat salary split proportionally by days (residual on last)', () => {
    // 4 cycles: 7,7,7,3 days (25-day window). Recurring only ⇒ weights follow days; amounts sum EXACTLY to net.
    const out = disburseNetAcrossCycles({
      net: 2400,
      recurring: 2400,
      overtime: 0,
      unpaid: 0,
      cycleDays: [7, 7, 7, 4],
      otMinutes: [0, 0, 0, 0],
      unpaidDays: [0, 0, 0, 0],
    });
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(2400, 5);
    // First three cycles are equal (same day count), last carries the remainder.
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);
    expect(out.length).toBe(4);
  });

  it('overtime lands in the cycle whose OT minutes are non-zero, not spread by days', () => {
    // Flat recurring split evenly; all OT worked in cycle 2 ⇒ cycle 2 gets the whole OT weight on top.
    const out = disburseNetAcrossCycles({
      net: 2000 + 300, // 2000 recurring + 300 OT
      recurring: 2000,
      overtime: 300,
      unpaid: 0,
      cycleDays: [14, 14],
      otMinutes: [0, 600],
      unpaidDays: [0, 0],
    });
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(2300, 5);
    // Cycle 2 (with the OT) is paid more than cycle 1 (recurring only).
    expect(out[1]).toBeGreaterThan(out[0]);
  });

  it('unpaid-leave days reduce the cycle they fall in; total still sums to net', () => {
    const out = disburseNetAcrossCycles({
      net: 1800, // 2000 recurring − 200 unpaid
      recurring: 2000,
      overtime: 0,
      unpaid: 200,
      cycleDays: [15, 15],
      otMinutes: [0, 0],
      unpaidDays: [3, 0], // unpaid days all in cycle 1
    });
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1800, 5);
    // Cycle 1 (with the unpaid deduction) is paid less than cycle 2.
    expect(out[0]).toBeLessThan(out[1]);
  });

  it('always sums to net exactly even with awkward rounding', () => {
    const out = disburseNetAcrossCycles({
      net: 1000.03,
      recurring: 1000.03,
      overtime: 0,
      unpaid: 0,
      cycleDays: [7, 7, 7],
      otMinutes: [0, 0, 0],
      unpaidDays: [0, 0, 0],
    });
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1000.03, 5);
  });
});
