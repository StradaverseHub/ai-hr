/**
 * ADR-0077 slice 9 — closure and reactivation.
 *
 * Every boundary is asserted with an INJECTED `today`, the core/dunning.ts pattern: these rules decide
 * whether a customer's payroll history starts being deleted, and whether an employee keeps leave they
 * could not use. Neither is something to discover by arranging a fixture.
 */
import { describe, expect, it } from 'vitest';
import {
  closureDecision,
  DATE_CLOCK_SWEEPS,
  replayPlan,
  SELF_HEALING_SWEEPS,
  shiftExpiryForSuspension,
  suspendedDaysWithin,
  type SuspensionWindow,
} from '../core/tenant-lifecycle';

const req = (over: Partial<Parameters<typeof closureDecision>[0]> = {}) => ({
  tenantStatus: 'suspended',
  requestedBy: 'alice',
  approvedBy: 'bob',
  retentionHeldUntil: null,
  today: '2026-08-03',
  ...over,
});

describe('slice 9 — closure is dual-controlled', () => {
  it('closes when two different people asked and approved, and nothing is held', () => {
    expect(closureDecision(req()).action).toBe('close');
  });

  it('REFUSES when one person both requested and approved', () => {
    const d = closureDecision(req({ requestedBy: 'alice', approvedBy: 'alice' }));
    expect(d.action).toBe('refuse');
    expect(d.reason).toContain('two different people');
  });

  it('REFUSES with no approver — a missing second person is not an implicit yes', () => {
    expect(closureDecision(req({ approvedBy: null })).action).toBe('refuse');
  });

  it('REFUSES with no recorded requester', () => {
    expect(closureDecision(req({ requestedBy: null })).action).toBe('refuse');
  });

  it('REFUSES an already-closed tenant rather than closing it twice', () => {
    expect(closureDecision(req({ tenantStatus: 'closed' })).action).toBe('refuse');
  });

  it('closes an ACTIVE tenant too — closure is a customer decision, not only a dunning endpoint', () => {
    expect(closureDecision(req({ tenantStatus: 'active' })).action).toBe('close');
  });
});

describe('slice 9 — closure respects statutory retention', () => {
  it('REFUSES while retention still runs — the law outlives the commercial relationship', () => {
    const d = closureDecision(req({ retentionHeldUntil: '2031-12-31' }));
    expect(d.action).toBe('refuse');
    expect(d.reason).toContain('2031-12-31');
  });

  it('allows closure once the hold has passed', () => {
    expect(closureDecision(req({ retentionHeldUntil: '2026-08-02' })).action).toBe('close');
  });

  it('a hold expiring TODAY does not block — the obligation is discharged', () => {
    expect(closureDecision(req({ retentionHeldUntil: '2026-08-03' })).action).toBe('close');
  });

  it('reports the missing APPROVAL before the retention date — the fixable thing first', () => {
    const d = closureDecision(req({ approvedBy: null, retentionHeldUntil: '2031-12-31' }));
    expect(d.reason).toContain('approved');
  });
});

describe('slice 9 — how long the tenant was frozen', () => {
  const w = (suspendedAt: string, resumedAt: string | null): SuspensionWindow => ({ suspendedAt, resumedAt });

  it('counts a closed window', () => {
    expect(suspendedDaysWithin([w('2026-03-01', '2026-03-11')], '2026-01-01', '2026-12-31')).toBe(10);
  });

  it('clips to the range asked about, not the whole window', () => {
    expect(suspendedDaysWithin([w('2026-03-01', '2026-03-31')], '2026-03-11', '2026-03-21')).toBe(10);
  });

  it('counts an OPEN window up to the end of the range — still-suspended is not zero', () => {
    expect(suspendedDaysWithin([w('2026-03-01', null)], '2026-01-01', '2026-03-21')).toBe(20);
  });

  it('a window entirely outside the range contributes nothing', () => {
    expect(suspendedDaysWithin([w('2025-01-01', '2025-06-01')], '2026-01-01', '2026-12-31')).toBe(0);
  });

  it('sums several windows', () => {
    const ws = [w('2026-02-01', '2026-02-11'), w('2026-05-01', '2026-05-06')];
    expect(suspendedDaysWithin(ws, '2026-01-01', '2026-12-31')).toBe(15);
  });

  it('no windows means nothing was frozen', () => {
    expect(suspendedDaysWithin([], '2026-01-01', '2026-12-31')).toBe(0);
  });
});

describe('slice 9 — an expiry moves by exactly the time the employee lost', () => {
  const w = (a: string, b: string | null): SuspensionWindow => ({ suspendedAt: a, resumedAt: b });

  it('pushes the deadline out by the frozen days', () => {
    // Earned 1 Jan, expires 1 Jul, tenant frozen 1-31 Mar (30 days) ⇒ 31 Jul.
    expect(shiftExpiryForSuspension('2026-07-01', '2026-01-01', [w('2026-03-01', '2026-03-31')])).toBe('2026-07-31');
  });

  it('leaves an expiry alone when nothing was frozen inside its clock', () => {
    expect(shiftExpiryForSuspension('2026-07-01', '2026-01-01', [])).toBe('2026-07-01');
  });

  it('does NOT move an expiry that already lapsed before the suspension began', () => {
    // The employee had their whole window and did not use it. Reinstatement is not a second chance.
    expect(shiftExpiryForSuspension('2026-02-01', '2026-01-01', [w('2026-03-01', '2026-03-31')])).toBe('2026-02-01');
  });

  it('counts only the frozen days INSIDE the clock, not the whole suspension', () => {
    // Frozen 1 Feb - 3 Mar, but the clock ends 11 Feb: only those 10 days were taken from the employee.
    expect(shiftExpiryForSuspension('2026-02-11', '2026-01-01', [w('2026-02-01', '2026-03-03')])).toBe('2026-02-21');
  });
});

describe('slice 9 — the replay plan distinguishes the two kinds of sweep', () => {
  it('an expiry sweep is replayed WITH a shifted clock, never plainly', () => {
    const [step] = replayPlan([{ sweep: 'expire-carry', skippedOn: '2026-03-02' }]);
    expect(step.action).toBe('rerun_with_shifted_expiry');
  });

  it('a self-healing sweep just re-runs once', () => {
    const [step] = replayPlan([{ sweep: 'accrue-earned', skippedOn: '2026-03-02' }]);
    expect(step.action).toBe('rerun');
  });

  it('COLLAPSES repeats — forty skipped nights is one replay, not forty forfeits', () => {
    const skipped = Array.from({ length: 40 }, (_, i) => ({
      sweep: 'expire-carry',
      skippedOn: `2026-03-${String((i % 28) + 1).padStart(2, '0')}`,
    }));
    expect(replayPlan(skipped)).toHaveLength(1);
  });

  it('an UNRECOGNISED sweep is not replayed blind', () => {
    const [step] = replayPlan([{ sweep: 'some-new-sweep', skippedOn: '2026-03-02' }]);
    expect(step.action).toBe('skip');
    expect(step.reason).toContain('deliberately');
  });

  it('the two sweep classes do not overlap — a sweep cannot be both', () => {
    for (const s of DATE_CLOCK_SWEEPS) expect(SELF_HEALING_SWEEPS.has(s)).toBe(false);
  });

  it('both r108 expiry sweeps are classified as date-clock', () => {
    // r108 named these two explicitly as the ones a plain re-run would break.
    expect(DATE_CLOCK_SWEEPS.has('expire-carry')).toBe(true);
    expect(DATE_CLOCK_SWEEPS.has('expire-aged-leave')).toBe(true);
  });
});
