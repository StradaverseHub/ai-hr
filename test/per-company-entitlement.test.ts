/**
 * ADR-0066 — per-company entitlement configuration.
 *
 *  (1) A company-scoped entitlement ALWAYS wins for that company — even when it grants FEWER days than the
 *      unrestricted default. Companies with no override keep the default.
 *  (2) All the call sites are company-aware (hire grant, openLeaveYear, accrueEarnedLeave, the read
 *      breakdown view).
 *  (3) Back-compat: with nothing company-scoped, behaviour is unchanged.
 *  (4) RETIRED by 38f1fd40. The festive one-off grant this section covered is removed; adjustments are
 *      written by the Leave Adjustments module now. Its day-validation property survives below, re-pointed
 *      at applyLeaveAdjustmentBatch, because test/leave-adjustment-batch.test.ts does not cover it.
 *  (5) RETIRED by 6e9a126e release three — see the note at the foot of this file. It asserted RLS WRITE
 *      SCOPING on `leave_policy.company_id`; the table is dropped and the replacement has no company
 *      column to scope on.
 *
 * ── 6e9a126e RELEASE THREE — WHAT MOVED AND WHAT DID NOT ─────────────────────────────────────────────
 *
 * REPOINTED, because the SUBJECT of this file — "two companies, two different numbers, and neither leaks
 * into the other" — survives the entitlement reset in full. A company-scoped `leave_policy` row is now an
 * entitlement template plus an eligibility rule whose criteria name the company, which is what
 * `seedEntitlement({ companyId })` writes. Every day count below is the figure it always was.
 *
 * THE SHORT-CIRCUIT BECAME SPECIFICITY, and that is the one thing to read carefully. `resolveGradePolicy`
 * tiered on COLUMNS: any company row at all short-circuited the group tier. The replacement ranks rules by
 * how many axes they narrow (`orgCriteriaSpecificity`, tie-broken by validFrom then created_at). For every
 * case this file ever asserted the two agree — `{companyIds:[A]}` narrows one axis and beats `{}` which
 * narrows none, `{companyIds:[A],gradeIds:[x]}` narrows two and beats both — so the numbers are unchanged
 * and the tiering is now proved END-TO-END rather than against hand-built rows.
 *
 * TWO DELIBERATE REDUCTIONS IN COVERAGE, both stated rather than quietly dropped:
 *
 *   • The pure `resolveGradePolicy` describe block is RETIRED WITH THE FUNCTION. It is not defined
 *     anywhere in core/ any more and has no callers — release three deleted it with the layer it resolved.
 *     Its six cases were about scope tiering, and the tiering they encode is re-asserted below through the
 *     real resolver, including the company+grade over company-only over unrestricted ladder that had no
 *     integration-level counterpart before.
 *
 *   • The `expireCarriedLeave` case is RETIRED and its substantive half REPOINTED at openLeaveYear.
 *     PER-COMPANY CARRY CAPS NO LONGER EXIST, and this is a real product fact rather than a fixture
 *     problem: 9816a5ad consolidated the carry rules (cap, expiry, percent) onto the LEAVE TYPE, and
 *     `applyLeaveTypeRules` overlays a ruled type's carry configuration WHOLESALE over the band's.
 *     `expireCarriedLeave` returns early unless the TYPE carries an expiry, and the moment the type does,
 *     every company shares its cap. A per-band carry cap is still read for an UNRULED type, so the claim
 *     this test actually made — each employee is carried under their OWN company's cap, with no
 *     cross-application — is asserted at the year open, which is where the cap is applied.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createCompany, createDepartment, createJobGrade, createLeaveType } from '../core/admin';
import { openLeaveYear, accrueEarnedLeave } from '../core/leave';
import { updateEntitlementTemplate } from '../core/entitlement-template';
import { leaveEntitlementBreakdown } from '../core/read';
// 38f1fd40 — the day-validation property moved here when the festive grant was retired.
import { applyLeaveAdjustmentBatch } from '../core/leave-adjustment';
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
const uniqEmail = () => `pce_${randomUUID().slice(0, 8)}@t.local`;

const annualBalance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

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

// ── Integration: a second company + employees in each ────────────────────────────────────────────────────
async function secondCompany(): Promise<{ coB: string; deptB: string }> {
  const a = adminCtx(b);
  const { id: coB } = await createCompany(a, { legalName: 'Sub B Sdn Bhd' });
  const dept = await createDepartment(a, { companyId: coB, name: 'B-Ops' });
  return { coB, deptB: dept.id };
}

/** Was `createLeavePolicy({ annualDays, companyId, gradeId })` — the days in a template, the scope in a rule. */
const policy = (annualDays: number, companyId: string | null, gradeId: string | null = null) =>
  seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays,
    companyId,
    gradeId,
    validFrom: '2026-01-01',
  });

/** The earning METHOD is a leave-TYPE rule since 9816a5ad — it was never a per-company decision, and the
 *  dropped `accrual` JSONB only looked like it was because it carried the days in the same object. The
 *  per-company part of an earned configuration is the annual figure, which is still a per-company table. */
const earnedMonthly = () =>
  owner.db
    .update(schema.leaveType)
    .set({ accrualMethod: 'earned_monthly' })
    .where(eq(schema.leaveType.id, b.annualLeaveTypeId));

// Hire on 1 Jan so ANNUAL grants in full (no mid-year pro-ration) → balance IS the entitlement.
const hireIn = (companyId: string, departmentId: string, gradeId: string | null = null) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Emp', primaryEmail: uniqEmail() },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    gradeId,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

describe('ADR-0066 per-company entitlement — call sites', () => {
  it('hire-time grant: company A gets 12, company B gets 14, both override the group default 16', async () => {
    const { coB, deptB } = await secondCompany();
    await policy(16, null); // unrestricted default
    await policy(12, b.companyId); // company A override (LOWER than the default)
    await policy(14, coB); // company B override
    const aEmp = await hireIn(b.companyId, b.deptA);
    const bEmp = await hireIn(coB, deptB);
    // The scoped rule wins because it NARROWS AN AXIS, not because it is more generous — A gets 12.
    expect(await annualBalance(aEmp.employmentId)).toBe(12);
    expect(await annualBalance(bEmp.employmentId)).toBe(14);
  });

  it('hire-time: a company with no override keeps the group default', async () => {
    const { coB, deptB } = await secondCompany();
    await policy(16, null);
    await policy(12, b.companyId);
    const bEmp = await hireIn(coB, deptB); // co B has no override
    expect(await annualBalance(bEmp.employmentId)).toBe(16);
  });

  // 6e9a126e release three — carried down from the retired pure `resolveGradePolicy` block, which is the
  // only place the FULL tiering ladder was ever asserted. It is worth having end-to-end precisely because
  // the mechanism changed underneath it: three rules all match the Executive in company A, and the winner
  // is the one narrowing the most axes rather than the one whose company column is non-null.
  it('company+grade beats company-only, and company-only beats the unrestricted default', async () => {
    const exec = await createJobGrade(adminCtx(b), { code: 'EXEC', name: 'Executive' });
    await policy(20, null); // unrestricted — 0 axes
    await policy(10, b.companyId); // company A — 1 axis
    await policy(18, b.companyId, exec.id); // company A + Executive — 2 axes
    const execEmp = await hireIn(b.companyId, b.deptA, exec.id);
    const staffEmp = await hireIn(b.companyId, b.deptA, null);
    expect(await annualBalance(execEmp.employmentId)).toBe(18);
    // …and the ungraded employee takes the company figure, NOT the more generous unrestricted 20.
    expect(await annualBalance(staffEmp.employmentId)).toBe(10);
  });

  it('openLeaveYear opens the per-company entitlement (existing employees)', async () => {
    const { coB, deptB } = await secondCompany();
    await policy(12, b.companyId);
    await policy(14, coB);
    // Hire in a PRIOR year so openLeaveYear(2026) treats them as existing (hiredOn < 2026-01-01).
    const mk = (companyId: string, departmentId: string) =>
      hireEmployee(adminCtx(b), {
        person: { fullName: 'Old', primaryEmail: uniqEmail() },
        companyId,
        departmentId,
        employmentType: 'full_time',
        hiredOn: '2025-06-01',
      });
    const aEmp = await mk(b.companyId, b.deptA);
    const bEmp = await mk(coB, deptB);
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await annualBalance(aEmp.employmentId)).toBe(12);
    expect(await annualBalance(bEmp.employmentId)).toBe(14);
  });

  it('accrueEarnedLeave accrues the per-company monthly amount', async () => {
    const { coB, deptB } = await secondCompany();
    await earnedMonthly();
    await policy(12, b.companyId);
    await policy(24, coB);
    const mk = (companyId: string, departmentId: string) =>
      hireEmployee(adminCtx(b), {
        person: { fullName: 'Acc', primaryEmail: uniqEmail() },
        companyId,
        departmentId,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
    const aEmp = await mk(b.companyId, b.deptA);
    const bEmp = await mk(coB, deptB);
    // After 6 months: A earns 12/12*6 = 6; B earns 24/12*6 = 12.
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-30' });
    expect(await annualBalance(aEmp.employmentId)).toBe(6);
    expect(await annualBalance(bEmp.employmentId)).toBe(12);
  });

  // 6e9a126e release three — was "expireCarriedLeave uses the employee's OWN company carry policy (no
  // cross-company corruption)". The sweep's own trigger moved to the leave TYPE (see the file header), so
  // the part of that claim which still has a mechanism behind it — each employee is carried under THEIR
  // company's cap and nobody else's — is asserted where the cap is now applied: the year open.
  it('year-open carry applies each employee’s OWN company cap (no cross-company corruption)', async () => {
    const { coB, deptB } = await secondCompany();
    // Company A: carry up to 5 days. Company B: carry nothing. The leave type stays UNRULED, which is what
    // keeps the per-band cap readable — a ruled type overlays one cap across every company.
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 12, carryForwardDays: 5 }],
      companyId: b.companyId,
      validFrom: '2025-01-01',
    });
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 12, carryForwardDays: 0 }],
      companyId: coB,
      validFrom: '2025-01-01',
    });
    const mk = (companyId: string, departmentId: string) =>
      hireEmployee(adminCtx(b), {
        person: { fullName: 'Carry', primaryEmail: uniqEmail() },
        companyId,
        departmentId,
        employmentType: 'full_time',
        hiredOn: '2024-06-01',
      });
    const aEmp = await mk(b.companyId, b.deptA);
    const bEmp = await mk(coB, deptB);
    await openLeaveYear(adminCtx(b), { year: 2025 });
    expect(await annualBalance(aEmp.employmentId)).toBe(12);
    expect(await annualBalance(bEmp.employmentId)).toBe(12);
    // 2026 opens on top of a full, unused 2025 balance: A carries 5 of its 12, B carries none.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await annualBalance(aEmp.employmentId)).toBe(17); // 12 carried down to the 5-day cap, + 12
    expect(await annualBalance(bEmp.employmentId)).toBe(12); // cap 0 ⇒ the 2025 balance is forfeited
  });

  it('read breakdown view shows the per-company number on the employee screen', async () => {
    const { coB, deptB } = await secondCompany();
    await policy(12, b.companyId);
    await policy(14, coB);
    const aEmp = await hireIn(b.companyId, b.deptA);
    const bEmp = await hireIn(coB, deptB);
    const aView = await leaveEntitlementBreakdown(adminCtx(b), aEmp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    const bView = await leaveEntitlementBreakdown(adminCtx(b), bEmp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(aView?.currentYearEntitlement).toBe(12);
    expect(bView?.currentYearEntitlement).toBe(14);
  });
});

// ── Back-compat: nothing company-scoped → unchanged ──────────────────────────────────────────────────────
describe('ADR-0066 back-compat — unrestricted entitlement unchanged', () => {
  it('with no company scope anywhere, the default (superseded to the latest version) still applies at hire', async () => {
    // Leave Entitlement Rules Engine (feedback a0228655): a second same-scope default SUPERSEDES the first
    // rather than coexisting as a duplicate. The template layer keeps that model — an edit closes the
    // running version at the successor's validFrom — so the second figure needs a strictly later date, and
    // the eligibility rule pointing at the LINEAGE needs no re-save. The pure-resolver's "literal duplicate
    // rows, most-generous tie-break" coverage lives in test/leave-service-bands.test.ts.
    const first = await policy(12, null);
    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: first.lineageId,
      serviceBands: [{ fromYears: 0, toYears: null, days: 16 }],
      validFrom: '2027-01-01', // strictly after the running version's validFrom
    });
    const emp = await hireEmployee(adminCtx(b), {
      person: { fullName: 'PCE', primaryEmail: `pce2_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2027-01-01',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    expect(await annualBalance(emp.employmentId)).toBe(16);
  });
});

// ── Festive / one-off grant ──────────────────────────────────────────────────────────────────────────────
async function festiveType(): Promise<string> {
  const lt = await createLeaveType(adminCtx(b), { code: 'FESTIVE', name: 'Festive Leave' });
  return lt.id;
}

describe('0.5-increment + 366-cap day validation (moved to the Leave Adjustments module by 38f1fd40)', () => {
  const base = (days: number) => async () => {
    const ft = await festiveType();
    await hireIn(b.companyId, b.deptA);
    void ft;
    return applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [b.annualLeaveTypeId],
      days,
      effectiveOn: '2026-03-01',
      reason: 'Validation probe',
      targetMode: 'criteria',
      criteria: { companyIds: [b.companyId] },
    });
  };

  // 0.501 was in this list when the retired grant owned the check, and it is NOT any more. The surviving
  // module rounds to 2dp BEFORE validating the increment (round2(0.501) === 0.5), so 0.501 is accepted as
  // half a day rather than refused. A real behavioural difference between the two write paths, recorded
  // here rather than quietly dropped: values that do not round ONTO a 0.5 increment still refuse.
  it.each([3.1, 2.7, 0.4])('rejects %s with the exact increment wording', async (bad) => {
    await expect(base(bad)()).rejects.toThrow('Days must be in 0.5 increments (e.g. 0.5, 1.0, -1.5).');
  });

  it('0.501 rounds onto a valid increment and is accepted — see the note above', async () => {
    const res = await base(0.501)();
    expect(res.written).toBe(1);
  });

  it.each([0.5, 1.0, 2.5])('accepts %s', async (good) => {
    const res = await base(good)();
    expect(res.written).toBe(1);
  });

  it('rejects a value above the 366-day cap', async () => {
    await expect(base(400)()).rejects.toThrow('Days cannot exceed 366.');
  });
});

// ── RETIRED by 6e9a126e release three: RLS write scoping on leave_policy ─────────────────────────────────
//
// The deleted block asserted that a COMPANY-SCOPED hr_admin could write a `leave_policy` row for their own
// company, was refused (WITH CHECK) for another company, and was refused for the group default
// (company_id NULL) — with a companion case for a group admin writing the NULL-company default.
//
// It is retired rather than repointed because THE GUARD IT DESCRIBED NO LONGER EXISTS TO POINT AT, and that
// is worth stating plainly rather than leaving a reader to infer it from a missing file. `leave_policy` had
// a real `company_id` column, which is what a WITH CHECK policy could scope a write on. Its replacement,
// `entitlement_eligibility_rule`, keeps the company inside `criteria` JSONB — one axis among fourteen — so
// there is no column for a row-level policy to test. Migration 0396 gives both new tables TENANT-scoped RLS
// and nothing finer (test/module-entitlement-rls.test.ts is about MODULE entitlements — a different table
// and no relation to this).
//
// ⚠️ THE COVERAGE LOSS IS REAL AND IS NOT A TEST-ONLY MATTER: a company-scoped hr_admin can now write an
// entitlement rule that reaches another company, or every company, and the database will not stop them.
// Whether that should be re-imposed in the service layer is a product decision, not something this file can
// assert its way to; it is reported with the round rather than papered over with a weaker tenant-level
// assertion that would pass while proving nothing about company scoping.
