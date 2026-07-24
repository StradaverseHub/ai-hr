/**
 * Configurable Earned Leave Entitlement Rules — policy-correction recalculation (feedback 49809272).
 *
 * updateLeavePolicy (the "correct in place / fix a mis-typed value" path) must FLOW THROUGH to
 * employees already granted this cycle: reprojectEntitlementForPolicy posts one compensating
 * `adjustment` (reason `sys:policy_recalc:<policyId>`) per affected employment for the delta between
 * the corrected current-cycle entitlement and what the ledger already holds, plus one
 * `leave.entitlement.recalculated` DomainEvent per row (real actor).
 *
 * Invariants under test:
 *  (1) upward + downward corrections move the balance by the delta (upfront method);
 *  (2) idempotency — an identical re-save posts nothing (delta 0), a no-entitlement edit skips entirely;
 *  (3) earned method re-projects elapsed periods only, and the accrual cron never double-grants the
 *      delta (its `already` sum sees the recalc adjustments);
 *  (4) scope — company-/grade-scoped corrections touch only their cohort;
 *  (5) closed prior years are never rewritten (current cycle only);
 *  (6) a forward-dated NEW version (createLeavePolicy) triggers no recalculation (effective-date logic);
 *  (7) EA-FLOOR — a below-floor correction claws back only down TO max(floor, policy), never below;
 *  (8) Balance/Ledger/Breakdown consistency — leaveEntitlementBreakdown reconciles in both directions.
 */
import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createCompany, createDepartment, createJobGrade, createLeavePolicy, updateLeavePolicy, updateLeaveType } from '../core/admin';
import {
  accrueEarnedLeave,
  entitledDays,
  openLeaveYear,
  projectExpectedEntitlement,
  POLICY_RECALC_REASON_PREFIX,
  type GradePolicyRow,
} from '../core/leave';
import { createGradeGroup, createBenefitScheme, upsertSchemeEntitlement } from '../core/benefit-scheme';
import { leaveBalances, leaveEntitlementBreakdown } from '../core/read';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const uniqEmail = () => `recalc_${randomUUID().slice(0, 8)}@t.local`;
const ASOF = '2026-06-30';

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const annualBalance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

const policy = (
  annualDays: number,
  opts?: { companyId?: string | null; gradeId?: string | null; method?: string; validFrom?: string },
) =>
  createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays,
    companyId: opts?.companyId ?? null,
    gradeId: opts?.gradeId ?? null,
    method: opts?.method,
    validFrom: opts?.validFrom ?? '2026-01-01',
  });

// Hire on 1 Jan so ANNUAL grants in full (no mid-year pro-ration) → balance IS the entitlement.
const hireIn = (
  companyId: string,
  departmentId: string,
  opts?: { gradeId?: string | null; hiredOn?: string },
) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Emp', primaryEmail: uniqEmail() },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: opts?.hiredOn ?? '2026-01-01',
    gradeId: opts?.gradeId ?? null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** All policy-recalc adjustment rows for one employment (owner read — bypasses RLS for assertions). */
const recalcRows = (employmentId: string) =>
  owner.db
    .select({
      days: schema.leaveLedger.days,
      effectiveOn: schema.leaveLedger.effectiveOn,
      reason: schema.leaveLedger.reason,
      entryType: schema.leaveLedger.entryType,
    })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        like(schema.leaveLedger.reason, `${POLICY_RECALC_REASON_PREFIX}:%`),
      ),
    );

/** All leave.entitlement.recalculated events for the tenant, oldest first. */
const recalcEvents = async () => {
  const rows = await owner.db
    .select({
      payload: schema.domainEvent.payload,
      actorType: schema.domainEvent.actorType,
      actorId: schema.domainEvent.actorId,
      subjectEmploymentId: schema.domainEvent.subjectEmploymentId,
      aggregateType: schema.domainEvent.aggregateType,
      seq: schema.domainEvent.sequence,
    })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, b.tenantId),
        eq(schema.domainEvent.eventType, 'leave.entitlement.recalculated'),
      ),
    );
  return rows.sort((a, z) => Number(a.seq) - Number(z.seq));
};

describe('49809272 — upfront correction (up / down / floor)', () => {
  it('upward correction 12 → 14 posts +2, balance 14, one event with the real actor + payload', async () => {
    const { id } = await policy(12);
    const emp = await hireIn(b.companyId, b.deptA);
    expect(await annualBalance(emp.employmentId)).toBe(12);

    const res = await updateLeavePolicy(adminCtx(b), { id, annualDays: 14, validFrom: '2026-01-01', asOf: ASOF });
    expect(res).toEqual({ affected: 1, totalDelta: 2 });
    expect(await annualBalance(emp.employmentId)).toBe(14);

    const rows = await recalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].days)).toBe(2);
    expect(rows[0].entryType).toBe('adjustment');
    expect(rows[0].effectiveOn).toBe(ASOF); // inside the current cycle window — prior years untouched
    expect(rows[0].reason).toBe(`${POLICY_RECALC_REASON_PREFIX}:${id}`);

    const events = await recalcEvents();
    expect(events.length).toBe(1);
    expect(events[0].actorType).toBe('user'); // the HR admin, not SYSTEM
    expect(events[0].actorId).toBe(b.adminUserId);
    expect(events[0].subjectEmploymentId).toBe(emp.employmentId);
    expect(events[0].aggregateType).toBe('leave-ledger');
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.policyId).toBe(id);
    expect(payload.leaveTypeId).toBe(b.annualLeaveTypeId);
    expect(payload.employmentId).toBe(emp.employmentId);
    expect(payload.before).toBe(12);
    expect(payload.after).toBe(14);
    expect(payload.delta).toBe(2);
    expect(payload.cycleStart).toBe('2026-01-01');
  });

  it('downward correction 14 → 12 posts −2 and the balance drops', async () => {
    const { id } = await policy(14);
    const emp = await hireIn(b.companyId, b.deptA);
    expect(await annualBalance(emp.employmentId)).toBe(14);

    const res = await updateLeavePolicy(adminCtx(b), { id, annualDays: 12, validFrom: '2026-01-01', asOf: ASOF });
    expect(res).toEqual({ affected: 1, totalDelta: -2 });
    expect(await annualBalance(emp.employmentId)).toBe(12);
    const events = await recalcEvents();
    expect((events[0].payload as Record<string, unknown>).delta).toBe(-2);
  });

  it('EA-FLOOR invariant: correcting 12 → 6 claws back only to the floor (8), never below', async () => {
    const { id } = await policy(12);
    const emp = await hireIn(b.companyId, b.deptA);
    const res = await updateLeavePolicy(adminCtx(b), { id, annualDays: 6, validFrom: '2026-01-01', asOf: ASOF });
    // entitlement = max(EA floor 8 for <2y service, policy 6) = 8 ⇒ delta −4, NOT −6.
    expect(res.totalDelta).toBe(-4);
    expect(await annualBalance(emp.employmentId)).toBe(8);
  });

  it('the enriched leave-policy.updated event carries the recalc summary', async () => {
    const { id } = await policy(12);
    await hireIn(b.companyId, b.deptA);
    await updateLeavePolicy(adminCtx(b), { id, annualDays: 14, validFrom: '2026-01-01', asOf: ASOF });
    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.aggregateId, id),
          eq(schema.domainEvent.eventType, 'leave-policy.updated'),
        ),
      );
    expect((ev.payload as { recalc?: unknown }).recalc).toEqual({ affected: 1, totalDelta: 2 });
  });
});

describe('49809272 — idempotency + no-op edits', () => {
  it('re-saving the identical correction posts nothing (delta already 0)', async () => {
    const { id } = await policy(12);
    const emp = await hireIn(b.companyId, b.deptA);
    const first = await updateLeavePolicy(adminCtx(b), { id, annualDays: 14, validFrom: '2026-01-01', asOf: ASOF });
    expect(first.affected).toBe(1);
    const second = await updateLeavePolicy(adminCtx(b), { id, annualDays: 14, validFrom: '2026-01-01', asOf: ASOF });
    expect(second).toEqual({ affected: 0, totalDelta: 0 });
    expect(await annualBalance(emp.employmentId)).toBe(14); // not 16
    expect((await recalcRows(emp.employmentId)).length).toBe(1); // one compensating row, not two
  });

  it('an entitlement-neutral edit (carry-forward cap only) posts no adjustment and no recalc event', async () => {
    const { id } = await policy(12);
    const emp = await hireIn(b.companyId, b.deptA);
    const res = await updateLeavePolicy(adminCtx(b), {
      id,
      annualDays: 12,
      carryForwardMax: 5, // carry rule changes; days/method/bands/scope do not
      validFrom: '2026-01-01',
      asOf: ASOF,
    });
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await annualBalance(emp.employmentId)).toBe(12);
    expect((await recalcRows(emp.employmentId)).length).toBe(0);
    expect((await recalcEvents()).length).toBe(0);
  });
});

describe('49809272 — earned (monthly accrual) method', () => {
  it('mid-cycle rate correction tops up elapsed periods only, and the cron never double-grants', async () => {
    const { id } = await policy(12, { method: 'earned_monthly' }); // 1 day / month
    const emp = await hireIn(b.companyId, b.deptA); // earned: hire grant skipped, cron accrues
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-05-31' }); // 5 periods × 1 = 5
    expect(await annualBalance(emp.employmentId)).toBe(5);

    // Raise 12 → 16.8 (1.4/period). Expected-to-date at May = 7 ⇒ +2 adjustment; NO future periods.
    const res = await updateLeavePolicy(adminCtx(b), {
      id,
      annualDays: 16.8,
      method: 'earned_monthly',
      validFrom: '2026-01-01',
      asOf: '2026-05-31',
    });
    expect(res).toEqual({ affected: 1, totalDelta: 2 });
    expect(await annualBalance(emp.employmentId)).toBe(7);

    // Idempotent against the CRON too: an immediate re-run must see the recalc credit in its
    // `already` sum and grant nothing (this is the accrueEarnedLeave widening under test).
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-05-31' });
    expect(await annualBalance(emp.employmentId)).toBe(7);

    // Next month the cron tops up exactly one more corrected period: 16.8/12 × 6 = 8.4.
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-30' });
    expect(await annualBalance(emp.employmentId)).toBe(8.4);
  });

  it('an earned employee with NOTHING materialized this cycle is skipped (the cron grants correctly later)', async () => {
    const { id } = await policy(12, { method: 'earned_monthly' });
    const emp = await hireIn(b.companyId, b.deptA); // no cron run yet ⇒ no accrual rows
    const res = await updateLeavePolicy(adminCtx(b), {
      id,
      annualDays: 16.8,
      method: 'earned_monthly',
      validFrom: '2026-01-01',
      asOf: '2026-05-31',
    });
    expect(res).toEqual({ affected: 0, totalDelta: 0 }); // nothing to correct — nothing was granted
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-05-31' });
    expect(await annualBalance(emp.employmentId)).toBe(7); // cron grants at the corrected rate, once
  });
});

describe('49809272 — scope filters', () => {
  it('a company-scoped correction only re-credits that company; the other company is untouched', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Sub B Sdn Bhd' });
    const deptB = (await createDepartment(a, { companyId: coB, name: 'B-Ops' })).id;
    const { id: polA } = await policy(12, { companyId: b.companyId });
    await policy(14, { companyId: coB });
    const empA = await hireIn(b.companyId, b.deptA);
    const empB = await hireIn(coB, deptB);
    expect(await annualBalance(empA.employmentId)).toBe(12);
    expect(await annualBalance(empB.employmentId)).toBe(14);

    const res = await updateLeavePolicy(a, {
      id: polA,
      annualDays: 13,
      companyId: b.companyId,
      validFrom: '2026-01-01',
      asOf: ASOF,
    });
    expect(res).toEqual({ affected: 1, totalDelta: 1 });
    expect(await annualBalance(empA.employmentId)).toBe(13);
    expect(await annualBalance(empB.employmentId)).toBe(14); // other company untouched
  });

  it('a grade-scoped correction only re-credits that grade', async () => {
    const a = adminCtx(b);
    const exec = await createJobGrade(a, { code: 'EXEC', name: 'Executive' });
    await policy(12); // all-grades default
    const { id: polExec } = await policy(15, { gradeId: exec.id });
    const empExec = await hireIn(b.companyId, b.deptA, { gradeId: exec.id });
    const empStaff = await hireIn(b.companyId, b.deptA);
    expect(await annualBalance(empExec.employmentId)).toBe(15);
    expect(await annualBalance(empStaff.employmentId)).toBe(12);

    const res = await updateLeavePolicy(a, {
      id: polExec,
      annualDays: 18,
      gradeId: exec.id,
      validFrom: '2026-01-01',
      asOf: ASOF,
    });
    expect(res).toEqual({ affected: 1, totalDelta: 3 });
    expect(await annualBalance(empExec.employmentId)).toBe(18);
    expect(await annualBalance(empStaff.employmentId)).toBe(12); // other grade untouched
  });
});

describe('49809272 — effective-date model preserved', () => {
  it('closed prior years are never rewritten — only the current cycle moves', async () => {
    const { id } = await policy(12, { validFrom: '2025-01-01' });
    const emp = await hireIn(b.companyId, b.deptA, { hiredOn: '2025-01-01' }); // 2025 grant: 12
    await openLeaveYear(adminCtx(b), { year: 2026 }); // 2025 forfeited (carry 0), 2026 grant: 12
    expect(await annualBalance(emp.employmentId)).toBe(12);
    const priorRows = () =>
      owner.db
        .select({ id: schema.leaveLedger.id })
        .from(schema.leaveLedger)
        .where(and(eq(schema.leaveLedger.employmentId, emp.employmentId), eq(schema.leaveLedger.effectiveOn, '2025-01-01')));
    const priorBefore = (await priorRows()).length;

    const res = await updateLeavePolicy(adminCtx(b), { id, annualDays: 14, validFrom: '2025-01-01', asOf: ASOF });
    // Only the OPEN 2026 cycle re-projects (+2 on its 12); the closed 2025 grant stays exactly as posted.
    expect(res).toEqual({ affected: 1, totalDelta: 2 });
    expect(await annualBalance(emp.employmentId)).toBe(14);
    expect((await priorRows()).length).toBe(priorBefore);
    const rows = await recalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(rows[0].effectiveOn).toBe(ASOF); // dated inside the current cycle, not backdated
  });

  it('a forward-dated NEW version (createLeavePolicy) posts NO recalculation', async () => {
    await policy(12);
    const emp = await hireIn(b.companyId, b.deptA);
    expect(await annualBalance(emp.employmentId)).toBe(12);
    await policy(20, { validFrom: '2027-01-01' }); // genuinely new version, applies from its own date
    expect(await annualBalance(emp.employmentId)).toBe(12); // unchanged now
    expect((await recalcEvents()).length).toBe(0);
  });

  it('correcting a FUTURE-dated version in place recalculates nothing today', async () => {
    await policy(12);
    const emp = await hireIn(b.companyId, b.deptA);
    const future = await policy(20, { validFrom: '2027-01-01' });
    const res = await updateLeavePolicy(adminCtx(b), {
      id: future.id,
      annualDays: 22,
      validFrom: '2027-01-01',
      asOf: ASOF,
    });
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await annualBalance(emp.employmentId)).toBe(12);
  });
});

describe('ae5b84d5 — kernel: entitledDays + the scheme hook in projectExpectedEntitlement', () => {
  const CAL = { hiredOn: '2024-01-01', leaveCycle: null, gradeId: null, companyId: 'C' };
  const upfront12: GradePolicyRow[] = [{ gradeId: null, companyId: null, accrual: { annualDays: 12 } }];
  const floor8 = () => 8;

  it('entitledDays: scheme supersedes policy (even 0), EA floor clamps on top, null falls back', () => {
    expect(entitledDays(8, null, 12)).toBe(12); // no scheme ⇒ policy
    expect(entitledDays(8, 15, 12)).toBe(15); // scheme supersedes policy
    expect(entitledDays(16, 10, 20)).toBe(16); // floor clamps a below-floor scheme
    expect(entitledDays(8, 0, 12)).toBe(8); // an explicit scheme 0 supersedes policy; floor holds
  });

  it('the hook supersedes policy days; the EA floor still clamps; null-returning hook is a no-op', () => {
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', upfront12, floor8, ASOF)?.expected).toBe(12);
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', upfront12, floor8, ASOF, () => 20)?.expected).toBe(20);
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', upfront12, floor8, ASOF, () => 4)?.expected).toBe(8); // floor
    // A hook that resolves no scheme is byte-identical to the absent hook.
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', upfront12, floor8, ASOF, () => null)?.expected).toBe(12);
  });

  it('maxBalanceDays clamps the kernel on the UPFRONT path (scheme days included)', () => {
    const capped: GradePolicyRow[] = [
      { gradeId: null, companyId: null, accrual: { annualDays: 12, serviceBands: [{ fromYears: 0, toYears: null, days: 12, maxBalanceDays: 10 }] } },
    ];
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', capped, floor8, ASOF)?.expected).toBe(10);
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', capped, floor8, ASOF, () => 20)?.expected).toBe(10);
  });

  it('maxBalanceDays clamps the kernel on the EARNED path', () => {
    const cappedEarned: GradePolicyRow[] = [
      {
        gradeId: null,
        companyId: null,
        accrual: { annualDays: 12, method: 'earned_monthly', serviceBands: [{ fromYears: 0, toYears: null, days: 12, maxBalanceDays: 5 }] },
      },
    ];
    // 6 elapsed periods at ASOF ⇒ raw 6, clamped to the 5-day cap.
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', cappedEarned, floor8, ASOF)?.expected).toBe(5);
  });

  it('anniversary company: the hook receives the year-open RE-RESOLVED years (called after the 5450 re-resolution)', () => {
    // Hired 2020-03-01, asOf 2026-06-15: anniversary cycle start = 2026-03-01 (6 completed years) but the
    // upfront branch re-anchors to the calendar year-open 2026-01-01 (5 completed years) — the hook must
    // see the FINAL years (5), matching the band anchor `pol` resolved with.
    const ann = { hiredOn: '2020-03-01', leaveCycle: 'anniversary', gradeId: null, companyId: 'C' };
    const calls: number[] = [];
    const r = projectExpectedEntitlement(ann, 'ANNUAL', [{ gradeId: null, companyId: null, accrual: { annualDays: 10 } }], floor8, '2026-06-15', (years) => {
      calls.push(years);
      return 20;
    });
    expect(calls).toEqual([5]);
    expect(r?.expected).toBe(20);
    expect(r?.windowStart).toBe('2026-01-01');
  });

  it('anniversary company: the earned defensive skip (null) is unchanged with the hook present', () => {
    // At the anniversary anchor (6y) the upfront policy wins; re-resolved at year-open (5y) the earned one
    // wins ⇒ the kernel skips defensively (returns null) — hook or no hook.
    const ann = { hiredOn: '2020-03-01', leaveCycle: 'anniversary', gradeId: null, companyId: 'C' };
    const flip: GradePolicyRow[] = [
      { gradeId: null, companyId: null, accrual: { annualDays: 0, serviceBands: [{ fromYears: 0, toYears: 6, days: 5 }, { fromYears: 6, toYears: null, days: 20 }] } },
      { gradeId: null, companyId: null, accrual: { annualDays: 0, method: 'earned_monthly', serviceBands: [{ fromYears: 0, toYears: 6, days: 10 }, { fromYears: 6, toYears: null, days: 5 }] } },
    ];
    expect(projectExpectedEntitlement(ann, 'ANNUAL', flip, floor8, '2026-06-15')).toBeNull();
    expect(projectExpectedEntitlement(ann, 'ANNUAL', flip, floor8, '2026-06-15', () => 99)).toBeNull();
  });
});

describe('ae5b84d5 — a policy edit no longer claws back scheme-superseded balances', () => {
  it('updateLeavePolicy trues up policy-driven employees but leaves scheme-covered ones at their scheme days', async () => {
    const ctx = adminCtx(b);
    const grade = await createJobGrade(ctx, { code: 'GH', name: 'Grade H' });
    const group = await createGradeGroup(ctx, { name: 'Grade H group', gradeIds: [grade.id] });
    const scheme = await createBenefitScheme(ctx, {
      companyId: b.companyId,
      employmentType: 'full_time',
      gradeGroupId: group.id,
      name: 'Permanent Grade H',
      status: 'active',
    });
    await upsertSchemeEntitlement(ctx, {
      benefitSchemeId: scheme.id,
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 20 }],
    });
    const { id } = await policy(12);
    const schemeEmp = await hireIn(b.companyId, b.deptA, { gradeId: grade.id });
    const plainEmp = await hireIn(b.companyId, b.deptA);
    expect(await annualBalance(schemeEmp.employmentId)).toBe(20); // scheme superseded the policy at hire
    expect(await annualBalance(plainEmp.employmentId)).toBe(12);

    // The latent bug this feature fixes: a routine policy edit used to project the scheme employee at the
    // POLICY days (13) and claw back the scheme-granted 7. Now the projection reads the scheme table.
    const res = await updateLeavePolicy(ctx, { id, annualDays: 13, validFrom: '2026-01-01', asOf: ASOF });
    expect(res).toEqual({ affected: 1, totalDelta: 1 }); // ONLY the plain employee moved
    expect(await annualBalance(plainEmp.employmentId)).toBe(13);
    expect(await annualBalance(schemeEmp.employmentId)).toBe(20); // untouched
    expect((await recalcRows(schemeEmp.employmentId)).length).toBe(0);
  });
});

describe('49809272 — Balance / Ledger / Breakdown consistency', () => {
  it('after an upward correction the breakdown reconciles (otherAdjustments carries the credit)', async () => {
    const { id } = await policy(12);
    const emp = await hireIn(b.companyId, b.deptA);
    await updateLeavePolicy(adminCtx(b), { id, annualDays: 14, validFrom: '2026-01-01', asOf: ASOF });
    const view = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(view?.currentYearEntitlement).toBe(12); // the original accrual rows
    expect(view?.otherAdjustments).toBe(2); // the recalc credit
    expect(view?.totalAvailable).toBe(14); // = balance (no pending) — Balance & Ledger agree
  });

  it('after a downward correction the breakdown still reconciles (signed recalc row surfaces)', async () => {
    const { id } = await policy(14);
    const emp = await hireIn(b.companyId, b.deptA);
    await updateLeavePolicy(adminCtx(b), { id, annualDays: 12, validFrom: '2026-01-01', asOf: ASOF });
    const view = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(view?.currentYearEntitlement).toBe(14);
    expect(view?.otherAdjustments).toBe(-2); // negative recalc row included by reason (feedback 49809272)
    expect(view?.totalAvailable).toBe(12);
  });
});

// ── b81d3c52 (this ticket): a rounding-method change re-figures already-granted balances ────────────────
// The change-gate norm() now includes roundingMethod, and a rounding-ONLY change posts its compensating row
// ACCRUAL-class so the tidied whole-day value lands ON the earned/entitled figure (all display surfaces read
// the same rounded number), matching the a2c precedent. Every existing days/method/bands recalc case above
// still posts adjustment-class (roundingOnlyChange is false) and reconciles via otherAdjustments — unchanged.
describe('b81d3c52 — rounding-method change reaches already-earned balances', () => {
  const HIRED_MID = '2026-05-01';
  /** The accrued (YTD Entitled) figure a ledger-derived surface shows — accrual-class only. */
  const accruedOf = async (employmentId: string) => {
    const rows = await leaveBalances(adminCtx(b), employmentId);
    return rows.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!.accrued;
  };
  /** A mid-year joiner whose prorated hire grant is a RAW FRACTION (16.44 × 8/12 = 10.96), so applyRounding
   *  is NOT a no-op — a plain integer-days ANNUAL lump would never surface a fraction. Rounding starts unset. */
  const joinerFractional = async () => {
    const { id } = await policy(16.44);
    const emp = await hireIn(b.companyId, b.deptA, { hiredOn: HIRED_MID });
    return { id, employmentId: emp.employmentId };
  };

  it('(a) with rounding UNSET the raw fraction shows on accrued AND balance', async () => {
    const { employmentId } = await joinerFractional();
    expect(await annualBalance(employmentId)).toBe(10.96);
    expect(await accruedOf(employmentId)).toBe(10.96);
  });

  it('(b) changing rounding to UP re-figures accrued / balance / entitlement to 11 via ONE accrual-class row', async () => {
    const { id, employmentId } = await joinerFractional();
    const res = await updateLeavePolicy(adminCtx(b), {
      id, annualDays: 16.44, roundingMethod: 'up', validFrom: '2026-01-01', asOf: ASOF,
    });
    expect(res).toEqual({ affected: 1, totalDelta: 0.04 });
    expect(await annualBalance(employmentId)).toBe(11);
    expect(await accruedOf(employmentId)).toBe(11); // YTD Entitled moves — accrual-class, not adjustment
    const view = await leaveEntitlementBreakdown(adminCtx(b), employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(view?.currentYearEntitlement).toBe(11); // the entitlement LINE itself reads the rounded figure
    expect(view?.otherAdjustments).toBe(0); // NOT a separate correction line beside a raw figure
    const rows = await recalcRows(employmentId);
    expect(rows.length).toBe(1);
    expect(rows[0].entryType).toBe('accrual');
    expect(Number(rows[0].days)).toBe(0.04);
  });

  it('(c) changing rounding to DOWN claws the balance back to 10 (negative accrual-class row)', async () => {
    const { id, employmentId } = await joinerFractional();
    const res = await updateLeavePolicy(adminCtx(b), {
      id, annualDays: 16.44, roundingMethod: 'down', validFrom: '2026-01-01', asOf: ASOF,
    });
    expect(res).toEqual({ affected: 1, totalDelta: -0.96 });
    expect(await annualBalance(employmentId)).toBe(10);
    expect(await accruedOf(employmentId)).toBe(10);
    const rows = await recalcRows(employmentId);
    expect(rows.length).toBe(1);
    expect(rows[0].entryType).toBe('accrual');
    expect(Number(rows[0].days)).toBe(-0.96);
  });

  it('(d) re-saving the identical rounding posts nothing (idempotent — accrual-class read back into `already`)', async () => {
    const { id, employmentId } = await joinerFractional();
    await updateLeavePolicy(adminCtx(b), { id, annualDays: 16.44, roundingMethod: 'up', validFrom: '2026-01-01', asOf: ASOF });
    const again = await updateLeavePolicy(adminCtx(b), { id, annualDays: 16.44, roundingMethod: 'up', validFrom: '2026-01-01', asOf: ASOF });
    expect(again).toEqual({ affected: 0, totalDelta: 0 });
    expect(await annualBalance(employmentId)).toBe(11);
    expect((await recalcRows(employmentId)).length).toBe(1); // one row, not two
  });

  it('(e) turning rounding OFF (up ⇒ none) restores the exact fraction (symmetric)', async () => {
    const { id, employmentId } = await joinerFractional();
    await updateLeavePolicy(adminCtx(b), { id, annualDays: 16.44, roundingMethod: 'up', validFrom: '2026-01-01', asOf: ASOF });
    expect(await annualBalance(employmentId)).toBe(11);
    const off = await updateLeavePolicy(adminCtx(b), { id, annualDays: 16.44, roundingMethod: 'none', validFrom: '2026-01-01', asOf: ASOF });
    expect(off).toEqual({ affected: 1, totalDelta: -0.04 });
    expect(await annualBalance(employmentId)).toBe(10.96);
    expect(await accruedOf(employmentId)).toBe(10.96);
  });

  it('(f) earned follow-on: the next accrual advances by the real amount only — no double-count of the correction', async () => {
    // 21.92 / 12 = 1.826667 per month; 6 periods ⇒ 10.96 raw with rounding unset.
    const { id } = await policy(21.92, { method: 'earned_monthly' });
    const emp = await hireIn(b.companyId, b.deptA); // 1 Jan hire, earned ⇒ no hire lump
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-30' });
    expect(await annualBalance(emp.employmentId)).toBe(10.96);

    const res = await updateLeavePolicy(adminCtx(b), {
      id, annualDays: 21.92, method: 'earned_monthly', roundingMethod: 'up', validFrom: '2026-01-01', asOf: '2026-06-30',
    });
    expect(res).toEqual({ affected: 1, totalDelta: 0.04 });
    expect(await annualBalance(emp.employmentId)).toBe(11);

    // 7 periods raw = 12.79 ⇒ up ⇒ 13; `already` = 11 (10.96 accrual + 0.04 accrual-class correction), so
    // the top-up is exactly +2. Were the correction not counted, `already` would be 10.96 ⇒ balance 13.04.
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-07-31' });
    expect(await annualBalance(emp.employmentId)).toBe(13);
  });

  it('(g) a2c parity: a first-year a2c employee rounds via the accrual-class a2c delegation', async () => {
    const A2C_ASOF = '2026-07-23'; // 199 days worked from 6 Jan ⇒ 20/365×199 = 10.90 raw
    await updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave', yearCycleOverride: 'a2c', asOf: A2C_ASOF });
    const { id } = await policy(20);
    const emp = await hireEmployee(adminCtx(b), {
      person: { fullName: 'A2C', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-06',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL', yearCycleOverride: 'a2c' }],
    });

    const res = await updateLeavePolicy(adminCtx(b), {
      id, annualDays: 20, roundingMethod: 'up', validFrom: '2026-01-01', asOf: A2C_ASOF,
    });
    expect(res.affected).toBe(1);
    // Delegated to reprojectA2cEntitlement (accrual-class), so YTD Entitled rounds UP to 11 — consistent
    // with the ordinary-employee path above.
    expect(await accruedOf(emp.employmentId)).toBe(11);
    expect(await annualBalance(emp.employmentId)).toBe(11);
  });

  it('(h) regression: a change to BOTH days and rounding is NOT rounding-only ⇒ stays adjustment-class', async () => {
    const { id } = await policy(12); // integer ⇒ no fraction
    const emp = await hireIn(b.companyId, b.deptA); // balance 12
    const res = await updateLeavePolicy(adminCtx(b), {
      id, annualDays: 15, roundingMethod: 'up', validFrom: '2026-01-01', asOf: ASOF,
    });
    expect(res).toEqual({ affected: 1, totalDelta: 3 }); // ceil(15) = 15 ⇒ +3; the rounding is a no-op on 15
    const rows = await recalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(rows[0].entryType).toBe('adjustment'); // days moved too ⇒ roundingOnlyChange is false
    const view = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(view?.currentYearEntitlement).toBe(12); // original accrual only
    expect(view?.otherAdjustments).toBe(3); // the days delta stays a separate adjustment (unchanged behaviour)
  });
});
