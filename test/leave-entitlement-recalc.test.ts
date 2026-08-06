/**
 * Configurable Earned Leave Entitlement Rules — entitlement-correction recalculation (feedback 49809272).
 *
 * Correcting a mis-typed entitlement figure must FLOW THROUGH to employees already granted this cycle: the
 * recalculation posts one compensating `adjustment` per affected employment for the delta between the
 * corrected current-cycle entitlement and what the ledger already holds, plus one
 * `leave.entitlement.recalculated` DomainEvent per row (real actor).
 *
 * ── 6e9a126e RELEASE THREE — WHAT MOVED, AND WHY THIS FILE IS STILL WORTH ITS LENGTH ──────────────────
 * The BEHAVIOUR above is untouched. What went with `leave_policy` is the TRIGGER and the reason string:
 *
 *   was:  updateLeavePolicy(...)  → reprojectEntitlementForPolicy   → `sys:policy_recalc:<policyId>`
 *   now:  updateEntitlementTemplate(...) THEN
 *         reprojectEntitlementForLeaveTypeCohort(...)               → `sys:profile_recalc:<employmentId>`
 *
 * Three consequences, all of them stated rather than absorbed:
 *  • THE CORRECTION IS TWO CALLS, NOT ONE. `updateLeavePolicy` recalculated as a side effect of saving.
 *    No template writer does — `createEntitlementTemplate`, `updateEntitlementTemplate`,
 *    `createEligibilityRule` and their actions in app/admin/leave/entitlements/templates/actions.ts all
 *    write and return. So each correction below writes the successor version and then runs the cohort
 *    recalculation explicitly, which is what an operator's save would have to do.
 *  • THE RETURN SHAPE IS `{ affected, totalDelta }`. `packBlocked` belonged to the policy-side reprojection;
 *    test/leave-pack-blocked-surfacing.test.ts owns that surface.
 *  • AN EDIT IS A SUPERSESSION, NOT AN OVERWRITE. `updateEntitlementTemplate` closes the running version and
 *    inserts a successor from a LATER date (it refuses `validFrom <= the open version's`), because three
 *    readers reproduce a PAST year and an in-place update would make them report today's figures. So the
 *    corrections below are dated inside the open cycle. Every arithmetic result is unchanged: the resolver
 *    reads the version in force AT `asOf`, which is the corrected one.
 *
 * Invariants under test:
 *  (1) upward + downward corrections move the balance by the delta (upfront method);
 *  (2) idempotency — an identical re-run posts nothing (delta 0), an entitlement-neutral edit skips;
 *  (3) earned method re-projects elapsed periods only, and the accrual cron never double-grants the
 *      delta (its `already` sum sees the recalc adjustments);
 *  (4) scope — a correction to a NARROWER entitlement table touches only the employees that table wins for,
 *      which after release three is decided by eligibility SPECIFICITY rather than by a policy row's grade;
 *  (5) closed prior years are never rewritten (current cycle only);
 *  (6) a forward-dated version changes nothing today (effective-date logic);
 *  (7) the projection kernel, directly: band days in, max-balance clamp, the anniversary re-resolution, and
 *      the "nothing resolves ⇒ SKIP, never zero" guard;
 *  (8) Balance/Ledger/Breakdown consistency — leaveEntitlementBreakdown reconciles in both directions.
 */
import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createCompany, createDepartment, createJobGrade, setLeaveTypeRules } from '../core/admin';
import {
  accrueEarnedLeave,
  openLeaveYear,
  projectExpectedEntitlement,
  reprojectEntitlementForLeaveTypeCohort,
  PROFILE_RECALC_REASON_PREFIX,
} from '../core/leave';
import { updateEntitlementTemplate } from '../core/entitlement-template';
import type { LeaveTypeRules, ServiceBand } from '../core/leave-compute';
import { leaveEntitlementBreakdown } from '../core/read';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';

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

/**
 * The DAYS for ANNUAL: an entitlement template plus the eligibility rule that assigns it. Returns the
 * template row, whose `lineageId` is what a later correction supersedes.
 *
 * ⚠️ EVERY TABLE GETS ITS OWN NAME. `entitlement_template_name_uq` refuses two RUNNING tables of the same
 * name under one leave type, and the scope tests below deliberately create two at once (a default and a
 * narrower one). A shared fixture name would surface as a unique-violation, not as a wrong number.
 */
const entitlement = (
  annualDays: number,
  opts?: { companyId?: string | null; gradeId?: string | null; validFrom?: string },
) =>
  seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays,
    companyId: opts?.companyId ?? null,
    gradeId: opts?.gradeId ?? null,
    validFrom: opts?.validFrom ?? '2026-01-01',
    name: `fixture ${randomUUID().slice(0, 8)}`,
  });

/**
 * THE CORRECTION, as release three performs it: supersede the running version of one entitlement table,
 * then run the cohort recalculation. Two calls, because no template writer recalculates — see the header.
 *
 * `validFrom` defaults to a date INSIDE the open 2026 cycle: an edit is a supersession and the writer
 * refuses a successor starting on or before its predecessor. The resolver reads the version in force at
 * `asOf`, so the corrected figure is what the projection sees and every delta below is unchanged.
 */
const correct = async (
  tpl: { lineageId: string },
  annualDays: number,
  opts?: { validFrom?: string; asOf?: string },
) => {
  await updateEntitlementTemplate(adminCtx(b), {
    lineageId: tpl.lineageId,
    serviceBands: [{ fromYears: 0, toYears: null, days: annualDays }],
    validFrom: opts?.validFrom ?? '2026-02-01',
  });
  const res = await reprojectEntitlementForLeaveTypeCohort(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    trigger: 'entitlement_template',
    asOf: opts?.asOf ?? ASOF,
  });
  return { affected: res.affected, totalDelta: res.totalDelta };
};

/** Run the cohort recalculation without changing anything — the no-op / idempotency probe. */
const recalcOnly = async (asOf = ASOF) => {
  const res = await reprojectEntitlementForLeaveTypeCohort(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    trigger: 'entitlement_template',
    asOf,
  });
  return { affected: res.affected, totalDelta: res.totalDelta };
};

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

/** All recalc adjustment rows for one employment (owner read — bypasses RLS for assertions). */
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
        like(schema.leaveLedger.reason, `${PROFILE_RECALC_REASON_PREFIX}:%`),
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

describe('49809272 — upfront correction (up / down / below the statutory minimum)', () => {
  it('upward correction 12 → 14 posts +2, balance 14, one event with the real actor + payload', async () => {
    const tpl = await entitlement(12);
    const emp = await hireIn(b.companyId, b.deptA);
    expect(await annualBalance(emp.employmentId)).toBe(12);

    const res = await correct(tpl, 14);
    expect(res).toEqual({ affected: 1, totalDelta: 2 });
    expect(await annualBalance(emp.employmentId)).toBe(14);

    const rows = await recalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].days)).toBe(2);
    expect(rows[0].entryType).toBe('adjustment');
    expect(rows[0].effectiveOn).toBe(ASOF); // inside the current cycle window — prior years untouched
    // RELEASE THREE: the reason names the EMPLOYMENT, not the policy row that no longer exists. Both
    // prefixes are still read back into the next run's `already` sum (recalcAdjustmentReasonCond), which is
    // what keeps a tenant carrying historical sys:policy_recalc rows idempotent across the cut.
    expect(rows[0].reason).toBe(`${PROFILE_RECALC_REASON_PREFIX}:${emp.employmentId}`);

    const events = await recalcEvents();
    expect(events.length).toBe(1);
    expect(events[0].actorType).toBe('user'); // the HR admin, not SYSTEM
    expect(events[0].actorId).toBe(b.adminUserId);
    expect(events[0].subjectEmploymentId).toBe(emp.employmentId);
    expect(events[0].aggregateType).toBe('leave-ledger');
    const payload = events[0].payload as Record<string, unknown>;
    // `policyId` went with leave_policy; `reason` + `trigger` are what name the cause now.
    expect(payload.reason).toBe('profile_recalc');
    expect(payload.trigger).toBe('entitlement_template');
    expect(payload.leaveTypeId).toBe(b.annualLeaveTypeId);
    expect(payload.employmentId).toBe(emp.employmentId);
    expect(payload.before).toBe(12);
    expect(payload.after).toBe(14);
    expect(payload.delta).toBe(2);
    expect(payload.cycleStart).toBe('2026-01-01');
  });

  it('downward correction 14 → 12 posts −2 and the balance drops', async () => {
    const tpl = await entitlement(14);
    const emp = await hireIn(b.companyId, b.deptA);
    expect(await annualBalance(emp.employmentId)).toBe(14);

    const res = await correct(tpl, 12);
    expect(res).toEqual({ affected: 1, totalDelta: -2 });
    expect(await annualBalance(emp.employmentId)).toBe(12);
    const events = await recalcEvents();
    expect((events[0].payload as Record<string, unknown>).delta).toBe(-2);
  });

  // fa3f4ccb — THE REPLACEMENT FOR THE EA-FLOOR INVARIANT. This test used to assert the override: a
  // correction to 6 clawed back only to the 8-day statutory floor. The reporter asked twice for that to
  // go, and approved it in writing. The configured figure is now the figure, so the correction lands on 6.
  // A real MY leave type at a real statutory band (ANNUAL, <2y ⇒ 8) — not a fixture floor of 0, which
  // would pass whatever the composition did.
  it('fa3f4ccb: correcting 12 → 6 claws back to 6, THROUGH the 8-day statutory minimum', async () => {
    const tpl = await entitlement(12);
    const emp = await hireIn(b.companyId, b.deptA);
    const res = await correct(tpl, 6);
    expect(res.totalDelta).toBe(-6);
    expect(await annualBalance(emp.employmentId)).toBe(6);
  });

  /*
   * RETIRED BY RELEASE THREE — 'the enriched leave-policy.updated event carries the recalc summary'.
   *
   * It asserted that `leave-policy.updated` carried `{ recalc: { affected, totalDelta, packBlocked } }`,
   * i.e. that the SAVE and the RECALCULATION were one audited act. There is no leave-policy.updated event
   * because there is no leave_policy, and the template writer's own `entitlement-template.superseded` event
   * carries no recalc summary — because it runs no recalculation.
   *
   * ⚠️ THAT IS A GAP IN THE PRODUCT, NOT ONLY IN THIS FILE, and it is recorded here rather than quietly
   * dropped. core/leave.ts's own header for reprojectEntitlementForLeaveTypeCohort says it fires "when an
   * entitlement TEMPLATE or an ELIGIBILITY RULE for the type is written" — no call site does that today
   * (app/admin/leave/entitlements/templates/actions.ts writes and returns; only setLeaveTypeRulesAction
   * fires the cohort, and only when it clears the not-configured marker). Until a writer calls it, an
   * operator correcting an entitlement table moves nobody's balance until some unrelated event happens to
   * reproject them. Wiring that is a product change and belongs in its own item; this file proves the
   * recalculation itself is correct when it is run.
   */
});

describe('49809272 — idempotency + no-op edits', () => {
  it('re-running the identical correction posts nothing (delta already 0)', async () => {
    const tpl = await entitlement(12);
    const emp = await hireIn(b.companyId, b.deptA);
    const first = await correct(tpl, 14);
    expect(first.affected).toBe(1);
    const second = await recalcOnly();
    expect(second).toEqual({ affected: 0, totalDelta: 0 });
    expect(await annualBalance(emp.employmentId)).toBe(14); // not 16
    expect((await recalcRows(emp.employmentId)).length).toBe(1); // one compensating row, not two
  });

  it('an entitlement-neutral edit (carry-forward cap only) posts no adjustment and no recalc event', async () => {
    await entitlement(12);
    const emp = await hireIn(b.companyId, b.deptA);
    // RELEASE THREE: the carry cap was a leave_policy column and is now a leave_type one (7cd914b1), so the
    // "change a carry rule, touch no entitlement" edit is written through setLeaveTypeRules. The point is
    // unchanged and still bites: `hasAnyLeaveTypeRule` flips to true here, so the whole overlay engages —
    // and the DAYS must still come out of the band untouched.
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, carryForwardMax: 5 });
    const res = await recalcOnly();
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await annualBalance(emp.employmentId)).toBe(12);
    expect((await recalcRows(emp.employmentId)).length).toBe(0);
    expect((await recalcEvents()).length).toBe(0);
  });
});

describe('49809272 — earned (monthly accrual) method', () => {
  /** The earning METHOD is a leave-type rule since 9816a5ad step 2 — never a property of the day table. */
  const earnedMonthly = () =>
    setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'earned_monthly' });

  it('mid-cycle rate correction tops up elapsed periods only, and the cron never double-grants', async () => {
    await earnedMonthly();
    const tpl = await entitlement(12); // 1 day / month
    const emp = await hireIn(b.companyId, b.deptA); // earned: hire grant skipped, cron accrues
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-05-31' }); // 5 periods × 1 = 5
    expect(await annualBalance(emp.employmentId)).toBe(5);

    // Raise 12 → 16.8 (1.4/period). Expected-to-date at May = 7 ⇒ +2 adjustment; NO future periods.
    const res = await correct(tpl, 16.8, { asOf: '2026-05-31' });
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
    await earnedMonthly();
    const tpl = await entitlement(12);
    const emp = await hireIn(b.companyId, b.deptA); // no cron run yet ⇒ no accrual rows
    const res = await correct(tpl, 16.8, { asOf: '2026-05-31' });
    expect(res).toEqual({ affected: 0, totalDelta: 0 }); // nothing to correct — nothing was granted
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-05-31' });
    expect(await annualBalance(emp.employmentId)).toBe(7); // cron grants at the corrected rate, once
  });
});

describe('49809272 — scope filters (now decided by eligibility specificity)', () => {
  it('a company-scoped correction only re-credits that company; the other company is untouched', async () => {
    const a = adminCtx(b);
    const { id: coB } = await createCompany(a, { legalName: 'Sub B Sdn Bhd' });
    const deptB = (await createDepartment(a, { companyId: coB, name: 'B-Ops' })).id;
    const tplA = await entitlement(12, { companyId: b.companyId });
    await entitlement(14, { companyId: coB });
    const empA = await hireIn(b.companyId, b.deptA);
    const empB = await hireIn(coB, deptB);
    expect(await annualBalance(empA.employmentId)).toBe(12);
    expect(await annualBalance(empB.employmentId)).toBe(14);

    const res = await correct(tplA, 13);
    // The cohort recalculation visits EVERY live employment on the type — deliberately a superset, per its
    // own note — so company B being untouched is a fact about RESOLUTION, not about a narrowed sweep. That
    // is a stronger reading of this test than the policy-scoped filter it replaces.
    expect(res).toEqual({ affected: 1, totalDelta: 1 });
    expect(await annualBalance(empA.employmentId)).toBe(13);
    expect(await annualBalance(empB.employmentId)).toBe(14); // other company untouched
  });

  it('a grade-scoped correction only re-credits that grade — the specificity winner', async () => {
    // ⚠️ THE ONE BEHAVIOURAL DIFFERENCE RELEASE THREE INTRODUCES, exercised end to end. A grade-scoped
    // leave_policy row used to beat a grade-less one by HAVING a grade. Now BOTH eligibility rules match an
    // Executive and the resolver picks the MOST SPECIFIC (orgCriteriaSpecificity). Same outcome, decided
    // somewhere else — and this test would fail if that ordering were ever reversed, because the staff
    // default (12) and the Executive table (15 → 18) are three different numbers.
    const a = adminCtx(b);
    const exec = await createJobGrade(a, { code: 'EXEC', name: 'Executive' });
    await entitlement(12); // all-grades default: an eligibility rule with EMPTY criteria = everyone
    const tplExec = await entitlement(15, { gradeId: exec.id });
    const empExec = await hireIn(b.companyId, b.deptA, { gradeId: exec.id });
    const empStaff = await hireIn(b.companyId, b.deptA);
    expect(await annualBalance(empExec.employmentId)).toBe(15);
    expect(await annualBalance(empStaff.employmentId)).toBe(12);

    const res = await correct(tplExec, 18);
    expect(res).toEqual({ affected: 1, totalDelta: 3 });
    expect(await annualBalance(empExec.employmentId)).toBe(18);
    expect(await annualBalance(empStaff.employmentId)).toBe(12); // other grade untouched
  });
});

describe('49809272 — effective-date model preserved', () => {
  it('closed prior years are never rewritten — only the current cycle moves', async () => {
    const tpl = await entitlement(12, { validFrom: '2025-01-01' });
    const emp = await hireIn(b.companyId, b.deptA, { hiredOn: '2025-01-01' }); // 2025 grant: 12
    await openLeaveYear(adminCtx(b), { year: 2026 }); // 2025 forfeited (carry 0), 2026 grant: 12
    expect(await annualBalance(emp.employmentId)).toBe(12);
    const priorRows = () =>
      owner.db
        .select({ id: schema.leaveLedger.id })
        .from(schema.leaveLedger)
        .where(and(eq(schema.leaveLedger.employmentId, emp.employmentId), eq(schema.leaveLedger.effectiveOn, '2025-01-01')));
    const priorBefore = (await priorRows()).length;

    const res = await correct(tpl, 14, { validFrom: '2026-01-01' });
    // Only the OPEN 2026 cycle re-projects (+2 on its 12); the closed 2025 grant stays exactly as posted —
    // and it stays that way BECAUSE the edit superseded rather than overwrote: the 2025 version is still on
    // the table, closed at 2026-01-01, which is what the three past-date readers resolve.
    expect(res).toEqual({ affected: 1, totalDelta: 2 });
    expect(await annualBalance(emp.employmentId)).toBe(14);
    expect((await priorRows()).length).toBe(priorBefore);
    const rows = await recalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(rows[0].effectiveOn).toBe(ASOF); // dated inside the current cycle, not backdated
  });

  it('a forward-dated NEW entitlement table changes nothing today', async () => {
    await entitlement(12);
    const emp = await hireIn(b.companyId, b.deptA);
    expect(await annualBalance(emp.employmentId)).toBe(12);
    await entitlement(20, { validFrom: '2027-01-01' }); // genuinely new table, applies from its own date
    const res = await recalcOnly();
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await annualBalance(emp.employmentId)).toBe(12); // unchanged now
    expect((await recalcEvents()).length).toBe(0);
  });

  it('correcting a FUTURE-dated table recalculates nothing today', async () => {
    await entitlement(12);
    const emp = await hireIn(b.companyId, b.deptA);
    const future = await entitlement(20, { validFrom: '2027-01-01' });
    const res = await correct(future, 22, { validFrom: '2027-06-01' });
    expect(res).toEqual({ affected: 0, totalDelta: 0 });
    expect(await annualBalance(emp.employmentId)).toBe(12);
  });
});

describe('ae5b84d5 — the projection kernel, directly', () => {
  const CAL = { hiredOn: '2024-01-01', leaveCycle: null, gradeId: null, companyId: 'C' };
  const floor8 = () => 8;
  /** The employee's winning entitlement-template band, as the kernel now receives it: a fn of service years. */
  const bandOf = (days: number, extra?: Partial<ServiceBand>) => (): ServiceBand => ({
    fromYears: 0,
    toYears: null,
    days,
    ...extra,
  });

  /*
   * RETIRED BY RELEASE THREE — the two `entitledDays` cases ('scheme supersedes policy, even 0' and 'a
   * template supersedes the scheme AND the policy'), and the scheme-hook case in the kernel.
   *
   * `entitledDays` does not exist: it WAS the multi-layer composition (`template ?? scheme ?? policy`), and
   * with two of those three layers dropped there is nothing left for it to arbitrate. Its successor is
   * `composeEntitlement`, which takes one band. Every case those tests made was a statement about
   * PRECEDENCE BETWEEN DROPPED TABLES — the one part of them that is not about a dropped table, "the floor
   * only flags, it never clamps", is asserted end to end in test/statutory-floor-advisory.test.ts and again
   * by the 12 → 6 case above.
   *
   * What replaces them here is the kernel's own contract over the surviving layer, INCLUDING the case those
   * tests never had: nothing resolving is a SKIP, not a zero.
   */
  it('the kernel projects the RESOLVED band days; the floor only flags, and nothing resolving is a SKIP', () => {
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', floor8, ASOF, undefined, undefined, bandOf(12))?.expected).toBe(12);
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', floor8, ASOF, undefined, undefined, bandOf(20))?.expected).toBe(20);
    // fa3f4ccb: was 8 (the floor). The kernel now projects what is configured, so a correction can claw
    // back below the EA minimum — the requested behaviour.
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', floor8, ASOF, undefined, undefined, bandOf(4))?.expected).toBe(4);
    // 6e9a126e — NO BAND IS NOT ZERO DAYS. null means "leave this employee alone"; a 0 here would make every
    // caller post `0 − alreadyPosted` and claw back everything already credited.
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', floor8, ASOF, undefined, undefined, () => null)).toBeNull();
  });

  it('maxBalanceDays clamps the kernel on the UPFRONT path', () => {
    // With NO leave-type rules the band's own maxBalanceDays is the clamp (applyLeaveTypeRules returns the
    // band's carrier untouched).
    const capped = bandOf(12, { maxBalanceDays: 10 });
    expect(projectExpectedEntitlement(CAL, 'ANNUAL', floor8, ASOF, undefined, undefined, capped)?.expected).toBe(10);
  });

  it('maxBalanceDays clamps the kernel on the EARNED path', () => {
    // ⚠️ THE EARNING METHOD IS A TYPE RULE, and the moment a type carries ANY rule `applyLeaveTypeRules`
    // overlays maxBalanceDays from the TYPE over whatever the band said. So on this path the clamp must be
    // stated on the type — a band-level 5 beside an earned method would be silently discarded.
    const earnedCapped: LeaveTypeRules = { accrualMethod: 'earned_monthly', maxBalanceDays: 5 };
    // 6 elapsed periods at ASOF ⇒ raw 6, clamped to the 5-day cap.
    expect(
      projectExpectedEntitlement(CAL, 'ANNUAL', floor8, ASOF, undefined, earnedCapped, bandOf(12))?.expected,
    ).toBe(5);
  });

  it('anniversary company: the band resolver is asked again at the year-open RE-RESOLVED years', () => {
    // Hired 2020-03-01, asOf 2026-06-15: anniversary cycle start = 2026-03-01 (6 completed years) but the
    // upfront branch re-anchors to the calendar year-open 2026-01-01 (5 completed years). The band the
    // composition finally uses must be the one resolved at the FINAL years (5), matching the sweeps' own
    // anchor — which is precisely why the kernel takes a FUNCTION of years and not a resolved band.
    const ann = { hiredOn: '2020-03-01', leaveCycle: 'anniversary', gradeId: null, companyId: 'C' };
    const calls: number[] = [];
    const r = projectExpectedEntitlement(ann, 'ANNUAL', floor8, '2026-06-15', undefined, undefined, (years) => {
      calls.push(years);
      return { fromYears: 0, toYears: null, days: 20 };
    });
    // Both anchors are probed, in order, and the LAST one is what composes. (The old scheme hook was called
    // once, after the re-resolution; the band resolver replaces the whole `resolveEntitlement` probe, so it
    // is called at both — the invariant being asserted, that the final answer is anchored at 5, is the same.)
    expect(calls).toEqual([6, 5]);
    expect(calls.at(-1)).toBe(5);
    expect(r?.expected).toBe(20);
    expect(r?.windowStart).toBe('2026-01-01');
  });

  /*
   * RETIRED BY RELEASE THREE — 'anniversary company: the earned defensive skip (null) is unchanged with the
   * hook present'.
   *
   * The skip it covered is still in the kernel (`if (isEarnedMethod(resolved.pol?.method)) return null`
   * inside the year-open re-resolution), but the STATE that reached it cannot be built any more. It needed
   * two competing configuration rows whose winner FLIPPED between an upfront and an earned method as the
   * service years moved — and the earning method is no longer a property of a configuration row at all
   * (9816a5ad step 2 put it on the leave TYPE). One type has one method at both anchors, so the branch can
   * only fire if the band resolver returns null at 6 years and a band at 5, which `validateServiceBands`
   * makes impossible for real data (the last band is open-ended, so a table that covers 5 covers 6).
   *
   * ⚠️ REPORTED AS A FINDING rather than reconstructed with an unreachable fixture: a defensive branch that
   * no real state can reach is dead code, and pinning it with a hand-made impossible input would assert
   * that the dead code stays rather than that anything is protected.
   */

  /*
   * RETIRED BY RELEASE THREE — the whole 'ae5b84d5 — a policy edit no longer claws back scheme-superseded
   * balances' block (one case).
   *
   * It proved that correcting a leave_policy left an employee whose days came from a BENEFIT SCHEME at
   * their scheme figure instead of clawing back to the policy number. That defect required two entitlement
   * layers to exist at once. There is one, so the bug it guards against has no way to occur; the surviving
   * half of its intent — a correction to one table must not move employees another table wins for — is the
   * grade-specificity case above, which asserts exactly that with three different numbers.
   */
});

describe('49809272 — Balance / Ledger / Breakdown consistency', () => {
  it('after an upward correction the breakdown reconciles (the credit lands in systemAdjustments)', async () => {
    const tpl = await entitlement(12);
    const emp = await hireIn(b.companyId, b.deptA);
    await correct(tpl, 14);
    const view = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(view?.currentYearEntitlement).toBe(12); // the original accrual rows
    // RELEASE THREE: the row's reason is now `sys:profile_recalc`, which the SIX-BUCKET partition classifies
    // as a system correction — the bucket that exists precisely because the legacy `otherAdjustments` field
    // omits sys:profile_recalc and every negative adjustment (0315dac7; pinned in
    // test/leave-balance-reconciliation.test.ts). Asserting systemAdjustments is the honest reading of the
    // same fact, and it holds in BOTH signs, which otherAdjustments never could.
    expect(view?.systemAdjustments).toBe(2); // the recalc credit
    expect(view?.totalAvailable).toBe(14); // = balance (no pending) — Balance & Ledger agree
  });

  it('after a downward correction the breakdown still reconciles (signed recalc row surfaces)', async () => {
    const tpl = await entitlement(14);
    const emp = await hireIn(b.companyId, b.deptA);
    await correct(tpl, 12);
    const view = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(view?.currentYearEntitlement).toBe(14);
    expect(view?.systemAdjustments).toBe(-2); // negative recalc row, accounted for rather than dropped
    expect(view?.totalAvailable).toBe(12);
  });
});

/*
 * ── RETIRED BY 6e9a126e RELEASE THREE ────────────────────────────────────────────────────────────────
 * THE WHOLE 'b81d3c52 — rounding-method change reaches already-earned balances' BLOCK (8 cases: a–h).
 *
 * WHAT IT PROVED. A change to the ROUNDING METHOD alone re-figured balances that had already been granted,
 * and posted its compensating row ACCRUAL-class rather than adjustment-class, so the tidied whole-day
 * figure landed ON "YTD Entitled" instead of beside it as a correction line. Cases: the raw fraction shows
 * with rounding unset (10.96); up ⇒ 11 via one accrual-class row; down ⇒ 10; idempotent re-save; turning
 * rounding off restores 10.96; the earned follow-on does not double-count the correction; an a2c first-year
 * employee rounds through the a2c delegation; and the regression that a days+rounding change is NOT
 * rounding-only and stays adjustment-class.
 *
 * WHY IT CANNOT BE REPOINTED. Two independent reasons, either of which alone is decisive:
 *  1. `roundingOnlyChange` and the accrual-class branch lived in `reprojectEntitlementForPolicy`, which is
 *     deleted with leave_policy. `reprojectEntitlementForEmployment` posts entryType 'adjustment' on every
 *     path except the a2c delegation. There is no accrual-class correction to assert.
 *  2. The methods these cases write — 'up', 'down', 'none' — are no longer WRITABLE. 8fec719e retired them:
 *     `setLeaveTypeRules` accepts only 'custom' or null, deliberately, so a retired choice cannot be stored
 *     again. `applyRounding` still EVALUATES them for rows the migration did not reach.
 * Making these pass would mean either asserting adjustment-class where the file's whole point was
 * accrual-class, or writing a retired method straight into the column behind the writer that refuses it.
 * Both are the kind of quiet loosening that turns a guard into decoration.
 *
 * WHAT COVERAGE IS ACTUALLY LOST: that a rounding change reaches ALREADY-GRANTED balances at all, and that
 * its row is accrual-class. The rounding ARITHMETIC itself is covered by test/leave-rounding-bands.test.ts,
 * test/leave-entitlement-rounding.test.ts, test/leave-entitlement-rounding-thresholds.test.ts and
 * test/leave-rounding-persistence.test.ts. Restoring the reach-back guard needs a custom-rounding-band
 * equivalent of case (b) written against the surviving cohort recalculation, and it will assert
 * adjustment-class — a deliberate behaviour change that belongs in its own item, not smuggled in here.
 */
