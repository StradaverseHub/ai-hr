/**
 * Board 124a979e, approved plan item 9 — "If the person making the change has no payroll rights for that company, the
 * payroll cannot be flagged at that moment. It is flagged the next time a payroll user opens the Payroll Process list."
 *
 * The saver records a pending row (payroll_recalc_pending, migration 7560) in the save's own transaction; the Payroll
 * Process list's refresh job, run under a payroll administrator, applies it with the normal mark helper as its first
 * step and deletes it. Pinned here with a real writer: an employee submitting their own TP3 (self-service, no payroll
 * administration), on a processed November run of theirs:
 *   - the save marks nothing and leaves exactly one pending row, which the employee cannot read back;
 *   - a payroll administrator of another company, or of another tenant, can neither read nor consume it;
 *   - the payroll administrator's refresh marks the run (Tax settings) and removes the row; a closed run in the same
 *     months is never marked;
 *   - a payroll administrator's own save records no pending row.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, consumeRecalcPendingTx, generatePayslips, listRecalcChangeCategories, markRunsAffectedByEmploymentChangeTx } from '../core/payroll';
import { submitMyTp3, type MyTp3WriteInput } from '../packs/payroll/service';
import { payrollRunOutstandingRefreshJobHandler } from '../core/payroll-run-outstanding';
import type { BulkJobRow } from '../core/bulk-job';
import { requirePackFor } from '../localization/registry';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); });
afterAll(closeAll);

const today = todayInKualaLumpur();
const year = Number(today.slice(0, 4));
const month = today.slice(0, 7);

async function employeeOnProcessedRun() {
  const admin = adminCtx(base);
  const hired = await hireEmployee(admin, {
    person: { fullName: 'Fictional pending saver', primaryEmail: `${randomUUID()}@example.invalid` },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: `${year}-01-01`,
  });
  await requirePackFor('MY').statutory.set(admin, { personId: hired.personId, icNumber: '900101015530', taxCategory: 1 });
  await setCompensation(admin, { employmentId: hired.employmentId, basicSalary: 6000, monthlyAllowance: 0, effectiveFrom: `${year}-01-01` });
  const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: month });
  await generatePayslips(admin, { batchId });
  // A CLOSED run inside the same tax year, written as the workforce invalidation test writes one.
  const closedPeriod = `${year}-01`;
  const [pp] = await owner.db.insert(schema.payPeriod).values({ tenantId: base.tenantId, companyId: base.companyId, period: closedPeriod, status: 'closed' }).returning();
  const [closed] = await owner.db.insert(schema.payrollBatch).values({ tenantId: base.tenantId, companyId: base.companyId, payPeriodId: pp.id, payPeriod: closedPeriod, batchDate: `${closedPeriod}-25`, status: 'closed' }).returning();
  await owner.db.insert(schema.payslip).values({ tenantId: base.tenantId, batchId: closed.id, employmentId: hired.employmentId, basicSalary: '6000.00', grossPay: '6000.00', netPay: '6000.00', totalDeductions: '0.00', employerCost: '6000.00', statutory: {} });
  const userId = await createAppUser(base.tenantId, hired.personId, 'employee');
  const self: SessionContext = { ...admin, userId, personId: hired.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: base.companyId }] };
  const input: MyTp3WriteInput = {
    employmentId: hired.employmentId, assessmentYear: year, expectedRevision: 0, deductionMonth: null,
    sectionC: { c1: { amount: 10000 }, c3: { amount: 1000 }, c5: { amount: 500 } }, sectionD: {},
    previousEmployers: [{ name: 'Fictional former employer', tin: 'F000001' }], declarationAccepted: true,
  };
  return { ...hired, admin, self, input, batchId, closed };
}

const batchRow = async (batchId: string) => (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0];
const pending = async (employmentId: string) =>
  owner.db.select().from(schema.payrollRecalcPending).where(and(eq(schema.payrollRecalcPending.tenantId, base.tenantId), eq(schema.payrollRecalcPending.employmentId, employmentId)));

describe('124a979e item 9 — saves without payroll administration are flagged at the next list refresh', () => {
  it('records one pending row, which only a payroll administrator of the company consumes, marking the open run only', async () => {
    const e = await employeeOnProcessedRun();
    const closedBefore = await batchRow(e.closed.id);

    await submitMyTp3(e.self, e.input);
    expect((await batchRow(e.batchId)).needsRecalcAt).toBeNull();
    const rows = await pending(e.employmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromPeriod: `${year}-01`, untilPeriod: `${year}-12`, categories: ['tax_profile'], requestedBy: e.self.userId });
    // The saver cannot read it back (read rule: payroll administration of the employee's company).
    expect(await withTenant(e.self, (tx) => tx.select().from(schema.payrollRecalcPending))).toEqual([]);

    // Another company's payroll administrator: nothing to read, nothing consumed.
    const [other] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Fictional other company' }).returning({ id: schema.company.id });
    const otherAdmin: SessionContext = { ...e.admin, grants: [{ role: 'hr_admin', companyId: other.id }] };
    expect(await withTenant(otherAdmin, (tx) => tx.select().from(schema.payrollRecalcPending))).toEqual([]);
    expect((await withTenant(otherAdmin, (tx) => consumeRecalcPendingTx(tx, otherAdmin))).consumed).toBe(0);
    // Another tenant's administrator: the same.
    const foreign = await seedBase();
    expect((await withTenant(adminCtx(foreign), (tx) => consumeRecalcPendingTx(tx, adminCtx(foreign)))).consumed).toBe(0);
    expect(await pending(e.employmentId)).toHaveLength(1);

    // The payroll administrator's list refresh: its first step consumes and marks.
    const job = { id: randomUUID(), input: { batchIds: [e.batchId] }, company_ids: [base.companyId] } as unknown as BulkJobRow;
    const prepared = await payrollRunOutstandingRefreshJobHandler.prepare!(e.admin, job);
    expect('steps' in prepared && prepared.steps[0]).toMatchObject({ kind: 'pending' });
    const step = { seq: 1, kind: 'pending', row_num: null, payload: { pending: true } } as unknown as Parameters<typeof payrollRunOutstandingRefreshJobHandler.applyStepTx>[3];
    const outcome = await withTenant(e.admin, (tx) => payrollRunOutstandingRefreshJobHandler.applyStepTx(tx, e.admin, job, step, new Map()));
    expect(outcome).toMatchObject({ counters: { pendingConsumed: 1 } });
    expect((await batchRow(e.batchId)).recalcEmploymentIds).toEqual([e.employmentId]);
    expect(await listRecalcChangeCategories(e.admin, { batchId: e.batchId })).toEqual({ [e.employmentId]: ['tax_profile'] });
    expect(await pending(e.employmentId)).toEqual([]);
    expect(await batchRow(e.closed.id)).toEqual(closedBefore);
  });

  it('a payroll administrator marks directly and records no pending row', async () => {
    const e = await employeeOnProcessedRun();
    await withTenant(e.admin, (tx) => markRunsAffectedByEmploymentChangeTx(tx, e.admin, { employmentIds: [e.employmentId], category: 'zakat', from: null }));
    expect((await batchRow(e.batchId)).recalcEmploymentIds).toEqual([e.employmentId]);
    expect(await pending(e.employmentId)).toEqual([]);
  });
});
