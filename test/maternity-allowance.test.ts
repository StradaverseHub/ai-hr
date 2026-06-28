/**
 * Phase-B #13 (audit #13, ADR-0062) — EA s.37 maternity paid-ALLOWANCE eligibility.
 *
 * The 98-day maternity LEAVE is unconditional (the eligibility gate only checks female-only). The paid
 * ALLOWANCE is withheld when EITHER:
 *   1. qualifying-service fails — she must have been employed at ANY time in the 4 months immediately
 *      before confinement AND for ≥90 days in the 9 months immediately before confinement, OR
 *   2. she already has ≥5 surviving children at confinement (the 5th-child proviso).
 * When withheld the leave is still granted but marked UNPAID (allowance_eligible=false + a reason), which
 * drives the existing leaveType.paid=false → unpaidDaysByEmployment payroll path. Missing inputs default to
 * the conservative current (paid) behaviour plus a "paid-allowance unconfirmed" warning.
 *
 * Covers: the pure resolver (qualifying met + <5 → paid; qualifying fails → 'qualifying_service'; 5th child →
 * 'fifth_child'); the per-request override on requestLeave (persisted columns + domain-event decision);
 * the missing-inputs warning; and the payroll integration (a withheld maternity counts as unpaid days).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { decideLeave, maternityAllowanceEligibility, requestLeave } from '../core/leave';
import { batchInputRows, createBatch } from '../core/payroll';
import { setCompensation } from '../core/comp';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

/** Hire a female employee with a given hire date and grant a maternity balance so the request can be made. */
async function hireFemale(hiredOn: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Mat', primaryEmail: `mat_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await owner.db
    .update(schema.person)
    .set({ gender: 'female', maritalStatus: 'married' })
    .where(eq(schema.person.id, e.personId));
  return e;
}

/** The seeded MY MATERNITY type (female-only, paid, 98 days). */
async function maternityType() {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: 'MATERNITY',
      name: 'Maternity Leave',
      paid: true,
      counting: 'calendar_days',
      eligibility: { gender: 'female' },
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Grant a positive balance for a leave type via an accrual ledger row. */
async function grantLedger(employmentId: string, leaveTypeId: string, days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

/** The persisted maternity columns for a request. */
async function requestRow(id: string) {
  const [row] = await owner.db
    .select({
      survivingChildren: schema.leaveRequest.survivingChildren,
      confinementDate: schema.leaveRequest.confinementDate,
      allowanceEligible: schema.leaveRequest.allowanceEligible,
    })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, id));
  return row;
}

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

describe('EA s.37 — maternity allowance pure resolver', () => {
  it('qualifying service met + <5 surviving children → eligible (paid)', () => {
    // Hired well before confinement: employed in the 4 months before AND ≥90 days in the 9 months before.
    const r = maternityAllowanceEligibility('2024-01-01', '2026-07-01', 2);
    expect(r).toEqual({ eligible: true, qualifyingService: true });
  });

  it('qualifying service FAILS (hired 2 weeks before confinement) → withheld, reason qualifying_service', () => {
    // Hired only ~2 weeks before confinement: < 90 days in the 9 months before (and the 4-month window is met
    // but the 90-day total is not). Allowance withheld even though survivingChildren < 5.
    const r = maternityAllowanceEligibility('2026-06-17', '2026-07-01', 0);
    expect(r).toEqual({ eligible: false, reason: 'qualifying_service', qualifyingService: false });
  });

  it('5th surviving child, qualifying service met → withheld, reason fifth_child', () => {
    const r = maternityAllowanceEligibility('2024-01-01', '2026-07-01', 5);
    expect(r).toEqual({ eligible: false, reason: 'fifth_child', qualifyingService: true });
  });

  it('qualifying service takes precedence when BOTH fail', () => {
    const r = maternityAllowanceEligibility('2026-06-17', '2026-07-01', 6);
    expect(r).toEqual({ eligible: false, reason: 'qualifying_service', qualifyingService: false });
  });
});

describe('EA s.37 — requestLeave per-request override', () => {
  it('qualifying met + <5 → paid maternity (allowanceEligible true, no unpaid)', async () => {
    const e = await hireFemale('2024-01-01');
    const mat = await maternityType();
    await grantLedger(e.employmentId, mat, '98.00');
    const res = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: mat,
      startDate: '2026-07-01',
      endDate: '2026-10-06', // 98 calendar days
      survivingChildren: 2,
      confinementDate: '2026-07-01',
    });
    const row = await requestRow(res.leaveRequestId);
    expect(row.allowanceEligible).toBe(true);
    expect(row.survivingChildren).toBe(2);
    expect(row.confinementDate).toBe('2026-07-01');
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.maternityAllowance).toMatchObject({
      allowanceEligible: true,
      qualifyingService: true,
      survivingChildren: 2,
      reason: null,
    });
  });

  it('qualifying FAILS → 98-day leave granted but UNPAID, reason qualifying_service', async () => {
    const e = await hireFemale('2026-06-17');
    const mat = await maternityType();
    await grantLedger(e.employmentId, mat, '98.00');
    const res = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: mat,
      startDate: '2026-07-01',
      endDate: '2026-10-06',
      survivingChildren: 0,
      confinementDate: '2026-07-01',
    });
    expect(res.days).toBe(98);
    const row = await requestRow(res.leaveRequestId);
    expect(row.allowanceEligible).toBe(false);
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.maternityAllowance).toMatchObject({
      allowanceEligible: false,
      reason: 'qualifying_service',
      qualifyingService: false,
      survivingChildren: 0,
    });
  });

  it('5th surviving child → 98-day leave granted but UNPAID, reason fifth_child', async () => {
    const e = await hireFemale('2024-01-01');
    const mat = await maternityType();
    await grantLedger(e.employmentId, mat, '98.00');
    const res = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: mat,
      startDate: '2026-07-01',
      endDate: '2026-10-06',
      survivingChildren: 5,
      confinementDate: '2026-07-01',
    });
    const row = await requestRow(res.leaveRequestId);
    expect(row.allowanceEligible).toBe(false);
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.maternityAllowance).toMatchObject({
      allowanceEligible: false,
      reason: 'fifth_child',
      qualifyingService: true,
      survivingChildren: 5,
    });
  });

  it('missing inputs → defaults to paid + an "unconfirmed" warning (existing behaviour preserved)', async () => {
    const e = await hireFemale('2024-01-01');
    const mat = await maternityType();
    await grantLedger(e.employmentId, mat, '98.00');
    const res = await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: mat,
      startDate: '2026-07-01',
      endDate: '2026-10-06',
      // no survivingChildren / confinementDate supplied
    });
    expect(res.days).toBe(98);
    expect(res.maternityAllowanceWarning).toBe(true);
    const row = await requestRow(res.leaveRequestId);
    // Conservative default: allowance unconfirmed ⇒ leave kept paid (allowance_eligible null = not withheld).
    expect(row.allowanceEligible).toBeNull();
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.maternityAllowance).toMatchObject({
      allowanceEligible: null,
      unconfirmed: true,
    });
  });
});

describe('EA s.37 — payroll integration (withheld allowance counts as unpaid)', () => {
  it('a withheld-allowance maternity request deducts unpaid days; a paid one does not', async () => {
    const withheld = await hireFemale('2026-06-17'); // qualifying fails
    const paid = await hireFemale('2024-01-01'); // qualifying met
    const mat = await maternityType();
    await grantLedger(withheld.employmentId, mat, '98.00');
    await grantLedger(paid.employmentId, mat, '98.00');
    for (const e of [withheld, paid]) {
      await setCompensation(adminCtx(b), {
        employmentId: e.employmentId,
        basicSalary: 3000,
        effectiveFrom: '2026-01-01',
      });
    }
    const withheldReq = await requestLeave(adminCtx(b), {
      employmentId: withheld.employmentId,
      leaveTypeId: mat,
      startDate: '2026-07-01',
      endDate: '2026-07-10', // 10 calendar days
      survivingChildren: 0,
      confinementDate: '2026-07-01',
    });
    const paidReq = await requestLeave(adminCtx(b), {
      employmentId: paid.employmentId,
      leaveTypeId: mat,
      startDate: '2026-07-01',
      endDate: '2026-07-10',
      survivingChildren: 0,
      confinementDate: '2026-07-01',
    });
    // Approve both so they are status='approved' (unpaidDaysByEmployment only counts approved).
    await decideLeave(adminCtx(b), { leaveRequestId: withheldReq.leaveRequestId, decision: 'approved' });
    await decideLeave(adminCtx(b), { leaveRequestId: paidReq.leaveRequestId, decision: 'approved' });

    const { batchId } = await createBatch(adminCtx(b), { companyId: b.companyId, payPeriod: '2026-07' });
    const rows = await batchInputRows(adminCtx(b), batchId);
    const byEmp = new Map(rows.map((r) => [r.employmentId, Number(r.unpaidDays)]));
    expect(byEmp.get(withheld.employmentId)).toBe(10); // withheld → 10 unpaid days
    expect(byEmp.get(paid.employmentId)).toBe(0); // paid → no unpaid days
  });
});
