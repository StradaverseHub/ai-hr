/**
 * ADR-0076 §7 — detector unit tests. NO DATABASE: every detector is pure, so a literal context is the
 * whole fixture. One fire / no-fire / boundary case each.
 *
 * These run in milliseconds and are the reason the detectors were specified as pure functions. The engine's
 * database behaviour (verdict rows, skip recording, idempotent re-run, events) is a separate integration
 * file — mixing the two would make the cheap tests as slow as the expensive ones.
 */
import { describe, it, expect } from 'vitest';
import {
  DETECTORS,
  resolveDisposition,
  type DetectorContext,
  type PayslipFigures,
  type Finding,
} from '../core/payroll-anomaly-detectors';

const figures = (over: Partial<PayslipFigures> = {}): PayslipFigures => ({
  grossPay: 5000,
  netPay: 4200,
  basicSalary: 5000,
  allowance: 0,
  overtimePay: 0,
  bonus: 0,
  totalDeductions: 800,
  daysWorked: 31,
  statutory: { epfEmployee: 550, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 215 },
  ...over,
});

const ctxOf = (over: Partial<DetectorContext> = {}): DetectorContext => ({
  employmentId: 'emp-1',
  current: figures(),
  prior: null,
  profile: {
    hasBankProfile: true,
    hasTaxProfile: true,
    paymentMethod: 'bank_transfer',
    hiredOn: '2020-01-01',
    terminatedOn: null,
    concurrentPaidEmploymentIds: [],
  },
  activity: { attendanceDays: 22, approvedLeaveDays: 0 },
  period: { start: '2026-08-01', end: '2026-08-31', calendarDays: 31 },
  caps: {},
  eventIds: ['ev-1'],
  ...over,
});

const run = (id: string, ctx: DetectorContext, params: Record<string, unknown> = {}): Finding[] => {
  const d = DETECTORS.find((x) => x.id === id);
  if (!d) throw new Error(`no detector ${id}`);
  return d.evaluate(ctx, params);
};

describe('ADR-0076 tripwires — every one works with zero history', () => {
  it('all tripwires declare priorCycles 0, so a first-ever cycle is fully covered by them', () => {
    const tripwires = [
      'negative-net',
      'zero-net-with-pay',
      'statutory-over-cap',
      'missing-bank-profile',
      'missing-tax-profile',
      'pay-without-attendance',
      'proration-mismatch',
      'duplicate-employment-pay',
    ];
    for (const id of tripwires) {
      expect(DETECTORS.find((d) => d.id === id)?.requires.priorCycles, id).toBe(0);
    }
  });

  it('negative-net fires and BLOCKS below zero, and not at exactly zero', () => {
    expect(run('negative-net', ctxOf({ current: figures({ netPay: -1 }) }))).toHaveLength(1);
    expect(run('negative-net', ctxOf({ current: figures({ netPay: -1 }) }))[0].severity).toBe('block');
    // Boundary: zero is not negative. zero-net-with-pay owns that case, at a lower severity.
    expect(run('negative-net', ctxOf({ current: figures({ netPay: 0 }) }))).toHaveLength(0);
  });

  it('zero-net-with-pay fires only when gross is positive — a genuinely zero slip is not an anomaly', () => {
    expect(run('zero-net-with-pay', ctxOf({ current: figures({ netPay: 0, grossPay: 5000 }) }))).toHaveLength(1);
    expect(run('zero-net-with-pay', ctxOf({ current: figures({ netPay: 0, grossPay: 0 }) }))).toHaveLength(0);
  });

  it('statutory-over-cap fires per component, reports the excess, and ignores components with no cap', () => {
    const ctx = ctxOf({
      current: figures({ statutory: { epfEmployee: 600, socsoEmployee: 24.75 } }),
      caps: { epfEmployee: 550 },
    });
    const out = run('statutory-over-cap', ctx);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('block');
    expect(out[0].facts).toMatchObject({ component: 'epfEmployee', actual: 600, cap: 550, excess: 50 });
    // Boundary: exactly at the cap is compliant, not over it.
    expect(run('statutory-over-cap', ctxOf({ current: figures({ statutory: { epfEmployee: 550 } }), caps: { epfEmployee: 550 } }))).toHaveLength(0);
  });

  it('missing-bank-profile fires only when there is money to pay', () => {
    expect(run('missing-bank-profile', ctxOf({ profile: { ...ctxOf().profile, hasBankProfile: false } }))).toHaveLength(1);
    // Nothing payable ⇒ no account needed ⇒ not an anomaly.
    expect(
      run('missing-bank-profile', ctxOf({ current: figures({ netPay: 0 }), profile: { ...ctxOf().profile, hasBankProfile: false } })),
    ).toHaveLength(0);
  });

  it('missing-bank-profile EXEMPTS cash and cheque, and still catches the legacy NULL payment method', () => {
    const noBank = { ...ctxOf().profile, hasBankProfile: false };
    // A cash-paid deskless worker legitimately has no bank details. Flagging the whole site workforce on
    // cycle one is the fastest way to teach an operator that this layer cries wolf.
    expect(run('missing-bank-profile', ctxOf({ profile: { ...noBank, paymentMethod: 'cash' } }))).toHaveLength(0);
    expect(run('missing-bank-profile', ctxOf({ profile: { ...noBank, paymentMethod: 'cheque' } }))).toHaveLength(0);
    // NULL predates migration 0270 and means bank transfer — treating it as "unknown, stay quiet" would
    // silently exempt most of the existing population.
    expect(run('missing-bank-profile', ctxOf({ profile: { ...noBank, paymentMethod: null } }))).toHaveLength(1);
  });

  it('pay-without-attendance needs BOTH zero attendance and zero approved leave', () => {
    const noActivity = { attendanceDays: 0, approvedLeaveDays: 0 };
    expect(run('pay-without-attendance', ctxOf({ activity: noActivity }))).toHaveLength(1);
    // A full month of APPROVED leave is not a ghost employee. Firing here would train the operator to
    // dismiss this detector, which is worse than not shipping it.
    expect(run('pay-without-attendance', ctxOf({ activity: { attendanceDays: 0, approvedLeaveDays: 22 } }))).toHaveLength(0);
  });

  it('proration-mismatch fires both ways, and stays silent on a plausible mid-period joiner', () => {
    // Employed all period but paid a partial basis.
    expect(run('proration-mismatch', ctxOf({ current: figures({ daysWorked: 15 }) }))).toHaveLength(1);
    // Joined mid-period but paid a full basis.
    expect(
      run('proration-mismatch', ctxOf({ current: figures({ daysWorked: 31 }), profile: { ...ctxOf().profile, hiredOn: '2026-08-15' } })),
    ).toHaveLength(1);
    // Joined mid-period with a plausible partial figure — the kernel's arithmetic is not re-derived here.
    expect(
      run('proration-mismatch', ctxOf({ current: figures({ daysWorked: 17 }), profile: { ...ctxOf().profile, hiredOn: '2026-08-15' } })),
    ).toHaveLength(0);
    // A legacy slip carries no basis and therefore cannot contradict one.
    expect(run('proration-mismatch', ctxOf({ current: figures({ daysWorked: null }) }))).toHaveLength(0);
  });

  it('duplicate-employment-pay BLOCKS when the same person is paid twice in one period', () => {
    const out = run('duplicate-employment-pay', ctxOf({ profile: { ...ctxOf().profile, concurrentPaidEmploymentIds: ['emp-2'] } }));
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('block');
    expect(out[0].facts.otherEmployments).toBe(1);
  });
});

describe('ADR-0076 prior-period detectors — self-disable on cycle 1', () => {
  it('all three declare priorCycles 1 and return nothing when there is no prior cycle', () => {
    for (const id of ['net-swing', 'component-appeared', 'component-vanished']) {
      expect(DETECTORS.find((d) => d.id === id)?.requires.priorCycles, id).toBe(1);
      expect(run(id, ctxOf({ prior: null })), id).toHaveLength(0);
    }
  });

  it('net-swing respects the configured threshold rather than a hardcoded one', () => {
    const ctx = ctxOf({ current: figures({ netPay: 6000 }), prior: figures({ netPay: 4000 }) }); // +50%
    expect(run('net-swing', ctx, { netSwingPct: 30 })).toHaveLength(1);
    // The SAME movement is unremarkable under a looser threshold — proving the value is read from config,
    // which is the whole point of thresholds-as-data (calibration must not require a deploy).
    expect(run('net-swing', ctx, { netSwingPct: 60 })).toHaveLength(0);
  });

  it('net-swing reports the movement it measured, in both directions', () => {
    const up = run('net-swing', ctxOf({ current: figures({ netPay: 6000 }), prior: figures({ netPay: 4000 }) }), {});
    expect(up[0].facts.movementPct).toBe(50);
    const down = run('net-swing', ctxOf({ current: figures({ netPay: 2000 }), prior: figures({ netPay: 4000 }) }), {});
    expect(down[0].facts.movementPct).toBe(-50);
  });

  it('net-swing stays silent when the prior net was zero — an infinite swing is component-appeared, not a swing', () => {
    expect(run('net-swing', ctxOf({ current: figures({ netPay: 4000 }), prior: figures({ netPay: 0 }) }))).toHaveLength(0);
  });

  it('component-appeared / -vanished are exact mirrors of each other', () => {
    const withOt = figures({ overtimePay: 800 });
    const noOt = figures({ overtimePay: 0 });
    const appeared = run('component-appeared', ctxOf({ current: withOt, prior: noOt }));
    expect(appeared.map((f) => f.facts.component)).toContain('overtimePay');
    const vanished = run('component-vanished', ctxOf({ current: noOt, prior: withOt }));
    expect(vanished.map((f) => f.facts.component)).toContain('overtimePay');
    // Unchanged components are silent in both directions.
    expect(run('component-appeared', ctxOf({ current: withOt, prior: withOt }))).toHaveLength(0);
    expect(run('component-vanished', ctxOf({ current: withOt, prior: withOt }))).toHaveLength(0);
  });
});

describe('ADR-0076 §2.5 — disposition is derived, never scored', () => {
  const f = (severity: Finding['severity']): Finding => ({
    detectorId: 'x',
    severity,
    facts: {},
    sourceEventIds: [],
    suggestedAction: 'k',
  });

  it('block dominates review dominates clean', () => {
    expect(resolveDisposition([])).toBe('auto_clear');
    expect(resolveDisposition([f('info')])).toBe('auto_clear');
    expect(resolveDisposition([f('review')])).toBe('review');
    expect(resolveDisposition([f('review'), f('block')])).toBe('block');
    // Order must not matter — findings arrive in registry order, which is display order, not priority.
    expect(resolveDisposition([f('block'), f('review')])).toBe('block');
  });

  it("'info' never escalates a verdict — it is a note, not a flag", () => {
    expect(resolveDisposition([f('info'), f('info'), f('info')])).toBe('auto_clear');
  });
});

describe('ADR-0076 — the invariants that keep this layer auditable', () => {
  it('every detector is PURE: the same context evaluated twice gives an identical result', () => {
    const ctx = ctxOf({
      current: figures({ netPay: -5, overtimePay: 300 }),
      prior: figures({ overtimePay: 0 }),
      profile: { ...ctxOf().profile, hasBankProfile: false, concurrentPaidEmploymentIds: ['emp-9'] },
      caps: { epfEmployee: 100 },
    });
    for (const d of DETECTORS) {
      expect(JSON.stringify(d.evaluate(ctx, {})), d.id).toBe(JSON.stringify(d.evaluate(ctx, {})));
    }
  });

  it('every detector id is unique and every finding reports the detector that produced it', () => {
    const ids = DETECTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const ctx = ctxOf({ current: figures({ netPay: -1 }) });
    for (const d of DETECTORS) {
      for (const finding of d.evaluate(ctx, {})) expect(finding.detectorId).toBe(d.id);
    }
  });

  it('suggestedAction is an i18n KEY, never prose — it is rendered in six locales', () => {
    const ctx = ctxOf({
      current: figures({ netPay: -1 }),
      profile: { ...ctxOf().profile, hasBankProfile: false, hasTaxProfile: false },
    });
    const found = DETECTORS.flatMap((d) => d.evaluate(ctx, {}));
    expect(found.length).toBeGreaterThan(0);
    for (const finding of found) {
      expect(finding.suggestedAction, finding.detectorId).toMatch(/^anomaly\.action\.[A-Za-z]+$/);
      expect(finding.suggestedAction).not.toContain(' ');
    }
  });

  it('a completely clean payslip produces no findings at all — the ordinary month is silent', () => {
    const clean = ctxOf({ prior: figures() });
    expect(DETECTORS.flatMap((d) => d.evaluate(clean, {}))).toHaveLength(0);
  });
});
