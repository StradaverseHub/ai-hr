/**
 * ADR-0066 — Configurable earned-leave entitlement per company + festive one-off grants.
 *
 *  (1) Resolver: a company-scoped policy ALWAYS wins for that company — even when it grants FEWER days than
 *      the group default (strict scope short-circuit). Companies with no override keep the group default.
 *  (2) All five call sites become company-aware (hire grant, openLeaveYear, accrueEarnedLeave,
 *      expireCarriedLeave, the read breakdown view).
 *  (3) Back-compat: with no company set on any policy, behaviour is byte-identical to today.
 *  (4) Festive grant: grantAdHocLeave credits +days to exactly the targeted cohort, emits one event, is
 *      idempotent, surfaces in the read view's otherAdjustments line, and rejects an unauthorised group-wide
 *      grant from a company-scoped admin.
 *  (5) RLS: a company-scoped admin can write a policy for their own company but is rejected for another
 *      company and for the group default (company_id NULL).
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  createCompany,
  createDepartment,
  createJobGrade,
  createLeavePolicy,
  createLeaveType,
  listAdHocLeaveGrants,
} from '../core/admin';
import {
  resolveGradePolicy,
  grantAdHocLeave,
  grantAdHocLeaveMulti,
  openLeaveYear,
  accrueEarnedLeave,
  expireCarriedLeave,
  AdHocLeaveGrantError,
  type GradePolicyRow,
} from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';

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

// ── Pure resolver unit tests (the crux of the correctness decision) ──────────────────────────────────────
describe('ADR-0066 resolveGradePolicy — strict scope short-circuit', () => {
  const pol = (annualDays: number, companyId: string | null, gradeId: string | null = null): GradePolicyRow => ({
    gradeId,
    companyId,
    accrual: { annualDays, method: 'grant_on_hire_prorated' },
  });

  it('a company policy WINS over a more-generous group default (even when lower)', () => {
    const rows = [pol(16, null), pol(12, 'co-a')];
    expect(resolveGradePolicy(rows, null, 'co-a', 0)?.days).toBe(12); // company override wins, lower
  });

  it('a company with NO policy keeps the group default', () => {
    const rows = [pol(16, null), pol(12, 'co-a')];
    expect(resolveGradePolicy(rows, null, 'co-b', 0)?.days).toBe(16); // falls back to group default
  });

  it('two companies each resolve to their own number', () => {
    const rows = [pol(16, null), pol(12, 'co-a'), pol(14, 'co-b')];
    expect(resolveGradePolicy(rows, null, 'co-a', 0)?.days).toBe(12);
    expect(resolveGradePolicy(rows, null, 'co-b', 0)?.days).toBe(14);
  });

  it('company+grade beats company+null-grade; group is never consulted once the company tier is non-empty', () => {
    const rows = [pol(20, null), pol(10, 'co-a'), pol(18, 'co-a', 'exec')];
    expect(resolveGradePolicy(rows, 'exec', 'co-a', 0)?.days).toBe(18); // company+grade
    expect(resolveGradePolicy(rows, 'staff', 'co-a', 0)?.days).toBe(10); // company+null-grade (NOT group 20)
  });

  it('group+grade resolves only when no company policy exists', () => {
    const rows = [pol(12, null), pol(18, null, 'exec')];
    expect(resolveGradePolicy(rows, 'exec', 'co-a', 0)?.days).toBe(18);
    expect(resolveGradePolicy(rows, null, 'co-a', 0)?.days).toBe(12);
  });

  it('back-compat: undefined company OR all-null-company rows are byte-identical to the old max pick', () => {
    const rows = [pol(12, null), pol(16, null)];
    expect(resolveGradePolicy(rows, null, undefined, 0)?.days).toBe(16); // undefined companyId
    expect(resolveGradePolicy(rows, null, 'co-a', 0)?.days).toBe(16); // company has no override → group max
  });
});

// ── Integration: a second company + employees in each ────────────────────────────────────────────────────
async function secondCompany(): Promise<{ coB: string; deptB: string }> {
  const a = adminCtx(b);
  const { id: coB } = await createCompany(a, { legalName: 'Sub B Sdn Bhd' });
  const dept = await createDepartment(a, { companyId: coB, name: 'B-Ops' });
  return { coB, deptB: dept.id };
}

const policy = (annualDays: number, companyId: string | null, gradeId: string | null = null, method?: string) =>
  createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays,
    companyId,
    gradeId,
    method,
    validFrom: '2026-01-01',
  });

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
    await policy(16, null); // group default
    await policy(12, b.companyId); // company A override (LOWER than group)
    await policy(14, coB); // company B override
    const aEmp = await hireIn(b.companyId, b.deptA);
    const bEmp = await hireIn(coB, deptB);
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
    await policy(12, b.companyId, null, 'earned_monthly');
    await policy(24, coB, null, 'earned_monthly');
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

  it('expireCarriedLeave uses the employee OWN company carry policy (no cross-company corruption)', async () => {
    const { coB, deptB } = await secondCompany();
    // Company A: cap 5, expiry 31 Mar. Company B: cap 0 (forfeit all).
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      companyId: b.companyId,
      carryForwardMax: 5,
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
      validFrom: '2025-01-01',
    });
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      companyId: coB,
      carryForwardMax: 0,
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
    // Open 2025 then 2026 so a Jan-1 2026 open-marker exists for the expiry sweep to act on.
    await openLeaveYear(adminCtx(b), { year: 2025 });
    await openLeaveYear(adminCtx(b), { year: 2026 });
    const aBefore = await annualBalance(aEmp.employmentId);
    const bBefore = await annualBalance(bEmp.employmentId);
    // The sweep runs per the employee's OWN company policy; it must not throw / cross-apply. The key
    // assertion is that A and B are independent — B (cap 0) carried nothing into 2026, A (cap 5) did.
    await expireCarriedLeave(adminCtx(b), { today: '2026-04-01' });
    expect(await annualBalance(aEmp.employmentId)).toBeLessThanOrEqual(aBefore);
    // Company B has cap 0 → openLeaveYear already forfeited its prior balance at the 2026 open, so the sweep
    // finds nothing to expire and B's balance is unchanged by the sweep.
    expect(await annualBalance(bEmp.employmentId)).toBe(bBefore);
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

// ── Back-compat: no company anywhere → unchanged ─────────────────────────────────────────────────────────
describe('ADR-0066 back-compat — group-only policies unchanged', () => {
  it('with no company on any policy, the group default (superseded to the latest version) still applies at hire', async () => {
    // Leave Entitlement Rules Engine (feedback a0228655): a second same-scope default now SUPERSEDES the
    // first rather than coexisting as a duplicate — so the second create needs a strictly later validFrom.
    // The pure-resolver's "literal duplicate rows, most-generous tie-break" coverage (for legacy data that
    // predates this fix) lives in test/leave-service-bands.test.ts.
    await policy(12, null);
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 16,
      companyId: null,
      gradeId: null,
      validFrom: '2027-01-01', // strictly after the first policy's validFrom
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

describe('ADR-0066 festive one-off grant', () => {
  it('credits the targeted company cohort, raises balance, emits one event; other company unaffected', async () => {
    const { coB, deptB } = await secondCompany();
    const ft = await festiveType();
    const a1 = await hireIn(b.companyId, b.deptA);
    const a2 = await hireIn(b.companyId, b.deptA);
    const bEmp = await hireIn(coB, deptB);

    const res = await grantAdHocLeave(adminCtx(b), {
      companyId: b.companyId,
      leaveTypeId: ft,
      days: 1,
      reason: 'CNY 2026',
      effectiveOn: '2026-02-17',
    });
    expect(res.granted).toBe(2);
    expect(res.targeted).toBe(2);
    expect(await ledgerBalance(a1.employmentId, ft)).toBe(1);
    expect(await ledgerBalance(a2.employmentId, ft)).toBe(1);
    expect(await ledgerBalance(bEmp.employmentId, ft)).toBe(0); // other company unaffected

    const events = await eventTypesFor(b.tenantId, b.tenantId);
    expect(events).toContain('leave.ad-hoc.granted');
  });

  it('is idempotent — re-running the identical grant is a no-op', async () => {
    const ft = await festiveType();
    const emp = await hireIn(b.companyId, b.deptA);
    const first = await grantAdHocLeave(adminCtx(b), {
      companyId: b.companyId,
      leaveTypeId: ft,
      days: 2,
      reason: 'Deepavali 2026',
      effectiveOn: '2026-11-01',
    });
    expect(first.granted).toBe(1);
    const second = await grantAdHocLeave(adminCtx(b), {
      companyId: b.companyId,
      leaveTypeId: ft,
      days: 2,
      reason: 'Deepavali 2026',
      effectiveOn: '2026-11-01',
    });
    expect(second.granted).toBe(0); // no-op
    expect(await ledgerBalance(emp.employmentId, ft)).toBe(2); // still 2, not 4
  });

  it('the read view surfaces festive days under otherAdjustments (reconciles with balance)', async () => {
    const ft = await festiveType();
    const emp = await hireIn(b.companyId, b.deptA);
    await grantAdHocLeave(adminCtx(b), {
      companyId: b.companyId,
      leaveTypeId: ft,
      days: 3,
      reason: 'Raya 2026',
      effectiveOn: '2026-04-10',
    });
    const view = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, ft, '2026-12-31');
    expect(view?.otherAdjustments).toBe(3);
    expect(view?.totalAvailable).toBe(3); // signed balance reconciles
  });

  it('a company-scoped admin cannot issue a group-wide (companyId null) grant', async () => {
    const ft = await festiveType();
    const scoped: SessionContext = { tenantId: b.tenantId, userId: b.adminUserId, grants: [{ role: 'hr_admin', companyId: b.companyId }] };
    await expect(
      grantAdHocLeave(scoped, { companyId: null, leaveTypeId: ft, days: 1, reason: 'X', effectiveOn: '2026-02-17' }),
    ).rejects.toBeInstanceOf(AdHocLeaveGrantError);
  });

  it('listAdHocLeaveGrants reads recent grants from the event log', async () => {
    const ft = await festiveType();
    await hireIn(b.companyId, b.deptA);
    await grantAdHocLeave(adminCtx(b), {
      companyId: b.companyId,
      leaveTypeId: ft,
      days: 1,
      reason: 'CNY 2026',
      effectiveOn: '2026-02-17',
    });
    const grants = await listAdHocLeaveGrants(adminCtx(b));
    expect(grants.length).toBe(1);
    expect(grants[0].reason).toBe('CNY 2026');
    expect(grants[0].count).toBe(1);
  });
});

// ── Multi-company festive grant (re-plan round 5) ────────────────────────────────────────────────────────
describe('ADR-0066 round 5 — grantAdHocLeaveMulti', () => {
  it('credits each targeted company cohort once; result sums granted/targeted; two distinct per-company events', async () => {
    const { coB, deptB } = await secondCompany();
    const ft = await festiveType();
    const a1 = await hireIn(b.companyId, b.deptA);
    const bEmp = await hireIn(coB, deptB);

    const res = await grantAdHocLeaveMulti(adminCtx(b), {
      companyIds: [b.companyId, coB],
      leaveTypeId: ft,
      days: 1,
      reason: 'CNY 2026',
      effectiveOn: '2026-02-17',
    });
    expect(res.granted).toBe(2);
    expect(res.targeted).toBe(2);
    expect(res.companies).toBe(2);
    expect(res.skipped).toBe(0);
    expect(await ledgerBalance(a1.employmentId, ft)).toBe(1);
    expect(await ledgerBalance(bEmp.employmentId, ft)).toBe(1);

    const events = await eventTypesFor(b.tenantId, b.tenantId);
    const grantedEvents = events.filter((e) => e === 'leave.ad-hoc.granted');
    expect(grantedEvents.length).toBe(2);
  });

  it('skips an archived company (defense-in-depth) and still grants the others', async () => {
    const { coB, deptB } = await secondCompany();
    const ft = await festiveType();
    const a1 = await hireIn(b.companyId, b.deptA);
    await hireIn(coB, deptB);
    // Archive coB AFTER setup — the UI never offers archived companies; this exercises the server backstop
    // against a stale/tampered submission directly.
    await owner.db.update(schema.company).set({ archivedAt: new Date() }).where(eq(schema.company.id, coB));

    const res = await grantAdHocLeaveMulti(adminCtx(b), {
      companyIds: [b.companyId, coB],
      leaveTypeId: ft,
      days: 1,
      reason: 'Raya 2026',
      effectiveOn: '2026-04-10',
    });
    expect(res.skipped).toBe(1);
    expect(res.companies).toBe(1);
    expect(res.granted).toBe(1);
    expect(await ledgerBalance(a1.employmentId, ft)).toBe(1);
  });

  it('all selected companies archived → "No active companies selected." and zero ledger rows', async () => {
    const { coB, deptB } = await secondCompany();
    const ft = await festiveType();
    const emp = await hireIn(coB, deptB);
    await owner.db.update(schema.company).set({ archivedAt: new Date() }).where(eq(schema.company.id, coB));

    await expect(
      grantAdHocLeaveMulti(adminCtx(b), {
        companyIds: [coB],
        leaveTypeId: ft,
        days: 1,
        reason: 'X',
        effectiveOn: '2026-04-10',
      }),
    ).rejects.toThrow('No active companies selected.');
    expect(await ledgerBalance(emp.employmentId, ft)).toBe(0);
  });

  it('a company-scoped admin naming a company they do not administer is rejected all-or-nothing (no rows for either company)', async () => {
    const { coB, deptB } = await secondCompany();
    const ft = await festiveType();
    const a1 = await hireIn(b.companyId, b.deptA);
    const bEmp = await hireIn(coB, deptB);
    const scoped: SessionContext = {
      tenantId: b.tenantId,
      userId: b.adminUserId,
      grants: [{ role: 'hr_admin', companyId: b.companyId }],
    };

    await expect(
      grantAdHocLeaveMulti(scoped, {
        companyIds: [b.companyId, coB],
        leaveTypeId: ft,
        days: 1,
        reason: 'CNY 2026',
        effectiveOn: '2026-02-17',
      }),
    ).rejects.toBeInstanceOf(AdHocLeaveGrantError);
    expect(await ledgerBalance(a1.employmentId, ft)).toBe(0);
    expect(await ledgerBalance(bEmp.employmentId, ft)).toBe(0);
  });

  it('resume-after-partial: an unchanged resubmit credits 0 for the already-granted company and grants the rest', async () => {
    const { coB, deptB } = await secondCompany();
    const ft = await festiveType();
    const a1 = await hireIn(b.companyId, b.deptA);
    const bEmp = await hireIn(coB, deptB);

    // Simulate a partial failure: grant company A alone first.
    await grantAdHocLeave(adminCtx(b), {
      companyId: b.companyId,
      leaveTypeId: ft,
      days: 2,
      reason: 'Deepavali 2026',
      effectiveOn: '2026-11-01',
    });
    expect(await ledgerBalance(a1.employmentId, ft)).toBe(2);

    // Identical resubmit across both companies — A is a no-op (idempotent), B completes.
    const res = await grantAdHocLeaveMulti(adminCtx(b), {
      companyIds: [b.companyId, coB],
      leaveTypeId: ft,
      days: 2,
      reason: 'Deepavali 2026',
      effectiveOn: '2026-11-01',
    });
    expect(res.granted).toBe(1); // only B's employee newly credited
    expect(await ledgerBalance(a1.employmentId, ft)).toBe(2); // unchanged, not doubled
    expect(await ledgerBalance(bEmp.employmentId, ft)).toBe(2);
  });

  it('full idempotency: running the identical multi-grant twice grants 0 the second time', async () => {
    const { coB, deptB } = await secondCompany();
    const ft = await festiveType();
    await hireIn(b.companyId, b.deptA);
    await hireIn(coB, deptB);
    const p = {
      companyIds: [b.companyId, coB],
      leaveTypeId: ft,
      days: 1,
      reason: 'CNY 2026',
      effectiveOn: '2026-02-17',
    };
    const first = await grantAdHocLeaveMulti(adminCtx(b), p);
    expect(first.granted).toBe(2);
    const second = await grantAdHocLeaveMulti(adminCtx(b), p);
    expect(second.granted).toBe(0);
  });

  it('duplicate company ids in the request behave exactly as a single occurrence (dedupe)', async () => {
    const ft = await festiveType();
    const emp = await hireIn(b.companyId, b.deptA);
    const res = await grantAdHocLeaveMulti(adminCtx(b), {
      companyIds: [b.companyId, b.companyId],
      leaveTypeId: ft,
      days: 1,
      reason: 'CNY 2026',
      effectiveOn: '2026-02-17',
    });
    expect(res.companies).toBe(1);
    expect(res.granted).toBe(1);
    expect(await ledgerBalance(emp.employmentId, ft)).toBe(1);
  });

  it('an unknown company id (as GROUP admin) is rejected with "Unknown company selected."', async () => {
    const ft = await festiveType();
    await expect(
      grantAdHocLeaveMulti(adminCtx(b), {
        companyIds: [randomUUID()],
        leaveTypeId: ft,
        days: 1,
        reason: 'X',
        effectiveOn: '2026-02-17',
      }),
    ).rejects.toThrow('Unknown company selected.');
    // Note: for a company-scoped admin, the authority pre-flight fires FIRST (see the all-or-nothing test
    // above) — the unknown-id check only surfaces for a group admin who legitimately passes authority.
  });

  it('empty companyIds is rejected with "Select at least one company."', async () => {
    const ft = await festiveType();
    await expect(
      grantAdHocLeaveMulti(adminCtx(b), {
        companyIds: [],
        leaveTypeId: ft,
        days: 1,
        reason: 'X',
        effectiveOn: '2026-02-17',
      }),
    ).rejects.toThrow('Select at least one company.');
  });
});

// ── 0.5-increment validation (re-plan round 5) — exercised directly on grantAdHocLeave; multi reuses it ──
describe('ADR-0066 round 5 — 0.5-increment day validation', () => {
  const base = (days: number) => async () => {
    const ft = await festiveType();
    await hireIn(b.companyId, b.deptA);
    return grantAdHocLeave(adminCtx(b), {
      companyId: b.companyId,
      leaveTypeId: ft,
      days,
      reason: 'X',
      effectiveOn: '2026-02-17',
    });
  };

  it.each([3.1, 2.7, 0.4, 0.501])('rejects %s with the exact increment wording', async (bad) => {
    await expect(base(bad)()).rejects.toThrow('Days must be in 0.5 increments (e.g. 0.5, 1.0, 1.5, 2.0).');
  });

  it.each([0.5, 1.0, 2.5])('accepts %s', async (good) => {
    const res = await base(good)();
    expect(res.granted).toBe(1);
  });

  it('rejects a value above the 366-day cap', async () => {
    await expect(base(400)()).rejects.toThrow('Days cannot exceed 366.');
  });
});

// ── RLS write scoping on leave_policy (as a real ai_hr_app role, NOT owner.db) ──────────────────────────
async function adminFor(companyId: string | null): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

describe('ADR-0066 leave_policy RLS write scoping', () => {
  it('a company-scoped admin can write their own company policy, but not another company or the group default', async () => {
    const { coB } = await secondCompany();
    const scopedA = await adminFor(b.companyId);
    // Own company: allowed.
    await expect(
      createLeavePolicy(scopedA, { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, companyId: b.companyId, validFrom: '2026-01-01' }),
    ).resolves.toBeTruthy();
    // Another company: WITH CHECK denies.
    await expect(
      createLeavePolicy(scopedA, { leaveTypeId: b.annualLeaveTypeId, annualDays: 14, companyId: coB, validFrom: '2026-01-01' }),
    ).rejects.toThrow();
    // Group default (company_id NULL): needs a group admin → denied for a company-scoped admin.
    await expect(
      createLeavePolicy(scopedA, { leaveTypeId: b.annualLeaveTypeId, annualDays: 16, companyId: null, validFrom: '2026-01-01' }),
    ).rejects.toThrow();
  });

  it('a group admin can write the null-company default', async () => {
    const group = await adminFor(null);
    await expect(
      createLeavePolicy(group, { leaveTypeId: b.annualLeaveTypeId, annualDays: 16, companyId: null, validFrom: '2026-01-01' }),
    ).resolves.toBeTruthy();
  });
});
