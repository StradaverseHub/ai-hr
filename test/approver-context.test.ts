/**
 * ADR-0038 2F-3 (R23) — approver context. listLeaveRequests exposes the applicant's current balance for
 * the requested leave type (the net leave_ledger sum), so an approver sees "do they have the days?"
 * beside each pending request.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { listLeaveRequests } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

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

describe('ADR-0038 2F-3 (R23) — applicant balance on the approvals queue', () => {
  it('reports the applicant net ledger balance for the requested leave type', async () => {
    const emp = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Ctx', primaryEmail: `ctx_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    // Accrued 12, already took 3 → balance 9.
    await owner.db.insert(schema.leaveLedger).values([
      { tenantId: b.tenantId, employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '12.00', effectiveOn: '2026-01-01' },
      { tenantId: b.tenantId, employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'debit', days: '-3.00', effectiveOn: '2026-03-01' },
    ]);
    await requestLeave(adminCtx(b), {
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });

    const rows = await listLeaveRequests(adminCtx(b), [b.companyId]);
    const r = rows.find((x) => x.employmentId === emp.employmentId);
    expect(r).toBeTruthy();
    expect(Number(r!.applicantBalance)).toBe(9);
  });

  it('reports zero for a leave type the applicant has no ledger entries for', async () => {
    const emp = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Zero', primaryEmail: `zero_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await requestLeave(adminCtx(b), {
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-02',
      endDate: '2026-07-02',
    });
    const rows = await listLeaveRequests(adminCtx(b), [b.companyId]);
    const r = rows.find((x) => x.employmentId === emp.employmentId);
    expect(Number(r!.applicantBalance)).toBe(0);
  });
});
