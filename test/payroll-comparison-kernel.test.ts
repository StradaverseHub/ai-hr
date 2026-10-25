/** Saved report -> real Payroll results -> comparison/export. Prepared during Board 2's resource
 * lease; execute only after the verified deployment handoff. No synthetic payslip inserts. */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createMovementEvent } from '../core/movement';
import {
  getCustomReport, recordPayrollComparisonRun, runPayrollComparisonReport,
  saveCustomReport, updateCustomReport,
} from '../core/custom-reports';
import { payrollComparisonSpec } from '../core/report-payroll-comparison';
import {
  closeBatch, createBatch, createIndividualTxn, generatePayslips, setPayrollPermissionGrant,
  seedPayComponentCatalog, backfillEmploymentComponentsFromCompensation,
} from '../packs/payroll/service';
import { requirePackFor } from '../localization/registry';
import { todayInKualaLumpur } from '../lib/hr-date';
import { previousPayrollComparisonPeriod } from '../lib/payroll-period-comparison';
import { serializePayrollComparison } from '../lib/payroll-comparison-export';
import {
  closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base,
} from './harness';

let b: Base, ctx: SessionContext, previousPeriod: string, currentPeriod: string;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'payroll', 'active');
  await setModule(b.tenantId, 'typed_pay_components', 'disabled');
  ctx = { ...await entitledCtx(b), grants: [{ role: 'hr_admin', companyId: null }] };
  // Both result periods are complete calendar months before the actual KL fixture date.
  currentPeriod = previousPayrollComparisonPeriod(todayInKualaLumpur().slice(0, 7));
  previousPeriod = previousPayrollComparisonPeriod(currentPeriod);
});

async function fixture(options: { typed?: boolean; allowance?: number } = {}) {
  const employee = await hireEmployee(ctx, {
    person: { fullName: 'Fictional Paid Result', primaryEmail: randomUUID() + '@fixture.test' },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time',
    employeeCode: 'COMPARE-001', hiredOn: previousPeriod + '-01',
  });
  await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 3000, monthlyAllowance: options.allowance ?? 0, effectiveFrom: previousPeriod + '-01' });
  await requirePackFor('MY').statutory.set(ctx, { personId: employee.personId, icNumber: '900101011234' });
  if (options.typed) {
    await seedPayComponentCatalog(ctx);
    await backfillEmploymentComponentsFromCompensation(ctx);
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    ctx = { ...await entitledCtx(b), grants: [{ role: 'hr_admin', companyId: null }] };
  }
  const previous = await createBatch(ctx, { companyId: b.companyId, payPeriod: previousPeriod });
  await generatePayslips(ctx, { batchId: previous.batchId });
  const current = await createBatch(ctx, { companyId: b.companyId, payPeriod: currentPeriod });
  const report = await saveCustomReport(ctx, {
    name: 'Fictional Basic comparison', datasetId: 'payroll_period_comparison',
    spec: payrollComparisonSpec(), companyIds: [b.companyId],
  });
  return { employee, previous, current, report };
}
function run(id: string, verb: 'view' | 'export' = 'view', actor = ctx) {
  return runPayrollComparisonReport(actor, [b.companyId], {
    id, verb, filters: { currentPeriod, previousPeriod },
  });
}
async function payrollSnapshot() {
  return {
    batches: await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.tenantId, b.tenantId)).orderBy(asc(s.payrollBatch.id)),
    results: await owner.db.select().from(s.payslip).where(eq(s.payslip.tenantId, b.tenantId)).orderBy(asc(s.payslip.id)),
    compensation: await owner.db.select().from(s.compensation).where(eq(s.compensation.tenantId, b.tenantId)).orderBy(asc(s.compensation.id)),
    employment: await owner.db.select().from(s.employment).where(eq(s.employment.tenantId, b.tenantId)).orderBy(asc(s.employment.id)),
  };
}

describe('Payroll comparison consumes generated paid results under the saved report authority', () => {
  it('compares another recorded pay item to the cent without substituting later compensation', async () => {
    const f = await fixture({ typed: true, allowance: 10.10 });
    await closeBatch(ctx, { batchId: f.previous.batchId });
    await setCompensation(ctx, { employmentId: f.employee.employmentId, basicSalary: 3000,
      monthlyAllowance: 10.11, effectiveFrom: currentPeriod + '-01' });
    await backfillEmploymentComponentsFromCompensation(ctx);
    await generatePayslips(ctx, { batchId: f.current.batchId });
    const saved = await getCustomReport(ctx, f.report.id, [b.companyId]);
    expect(saved).not.toBeNull();
    const spec = structuredClone(saved!.spec);
    spec.payrollComparison!.payItemCode = 'ALLOWANCE';
    await updateCustomReport(ctx, { id: saved!.id, name: saved!.name, version: saved!.version,
      spec, companyIds: [b.companyId] });
    await setCompensation(ctx, { employmentId: f.employee.employmentId, basicSalary: 9999,
      monthlyAllowance: 999, effectiveFrom: todayInKualaLumpur().slice(0, 7) + '-01' });
    const before = await payrollSnapshot(), view = await run(f.report.id), exported = await run(f.report.id, 'export');
    expect(view.result.available).toBe(true);
    expect(view.result.rows).toHaveLength(1);
    expect(view.result.rows[0]).toMatchObject({ employmentId: f.employee.employmentId,
      previous: '10.10', current: '10.11', variance: '0.01', currency: 'MYR' });
    expect(exported.result.rows).toEqual(view.result.rows);
    const file = await serializePayrollComparison(exported, 'xlsx');
    const book = XLSX.read(file.bytes, { type: 'array' });
    expect(XLSX.utils.sheet_to_json(book.Sheets.Details)).toEqual([expect.objectContaining({
      'Previous amount': 10.10, 'Current amount': 10.11, Variance: 0.01,
    })]);
    expect(await payrollSnapshot()).toEqual(before);
  });

  it('retains saved Basic instead of later master salary, with matching native workbook and metadata-only audit', async () => {
    const f = await fixture();
    await closeBatch(ctx, { batchId: f.previous.batchId });
    await createMovementEvent(ctx, {
      employmentId: f.employee.employmentId, kind: 'increment', effectiveDate: currentPeriod + '-01',
      basicSalary: 3200, remarks: 'Fictional recorded salary increase',
    });
    await generatePayslips(ctx, { batchId: f.current.batchId });
    // A later, genuine compensation revision must never be substituted for either saved result.
    await setCompensation(ctx, { employmentId: f.employee.employmentId, basicSalary: 9999, effectiveFrom: todayInKualaLumpur().slice(0, 7) + '-01' });
    const before = await payrollSnapshot();
    expect(before.results).toHaveLength(2);
    expect(before.results.find(row => row.batchId === f.previous.batchId)?.basicSalary).toBe('3000.00');
    expect(before.results.find(row => row.batchId === f.current.batchId)?.basicSalary).toBe('3200.00');
    const eventsBefore = await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId, b.tenantId)).orderBy(asc(s.domainEvent.sequence));
    const view = await run(f.report.id), exported = await run(f.report.id, 'export');
    expect(view.result).toMatchObject({ available: true, provisional: true, displayedRows: 1 });
    expect(view.result.rows).toHaveLength(1);
    expect(view.result.rows[0]).toMatchObject({ employmentId: f.employee.employmentId, previous: '3000.00', current: '3200.00', variance: '200.00', variancePct: '6.67', currency: 'MYR', reason: { reason: 'increment', effectiveDate: currentPeriod + '-01' } });
    expect(exported.result.rows).toEqual(view.result.rows); expect(exported.result.summary).toEqual(view.result.summary);
    expect(exported.sourceRevisions).toEqual(before.results.map(row => ({ id: row.id, version: row.version, runId: row.batchId })));
    expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId, b.tenantId)).orderBy(asc(s.domainEvent.sequence))).toEqual(eventsBefore);
    const file = await serializePayrollComparison(exported, 'xlsx');
    const workbook = XLSX.read(file.bytes, { type: 'array' });
    const details = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Details);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ 'Emp no.': 'COMPARE-001', 'Previous amount': 3000, 'Current amount': 3200, Variance: 200 });
    const auditId = await recordPayrollComparisonRun(ctx, exported, 'export', 'xlsx');
    const [audit] = await owner.db.select().from(s.customReportRun).where(eq(s.customReportRun.id, auditId));
    expect(audit).toMatchObject({ reportId: f.report.id, kind: 'export', format: 'xlsx', outcome: 'success', rowCount: 1 });
    const events = await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, f.report.id), eq(s.domainEvent.eventType, 'custom-report.comparison-recorded'))).orderBy(asc(s.domainEvent.sequence));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ auditId, sourceRevisions: exported.sourceRevisions });
    for (const key of ['rows', 'employeeName', 'basicSalary', 'previous', 'current', 'variance']) expect(events[0].payload).not.toHaveProperty(key);
    expect(await payrollSnapshot()).toEqual(before);
  });

  it('refuses unclosed previous, uncalculated current and stale results before exposing any partial amounts', async () => {
    const f = await fixture();
    const unclosed = await run(f.report.id);
    expect(unclosed.result.available).toBe(false);
    expect(unclosed.result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['previousNotClosed', 'draftPayroll']));
    expect(unclosed.result.rows).toEqual([]); expect(unclosed.result.summary).toBeNull();
    await closeBatch(ctx, { batchId: f.previous.batchId });
    const draft = await run(f.report.id);
    expect(draft.result.issues.map(issue => issue.code)).toEqual(['draftPayroll']);
    expect(draft.result.rows).toEqual([]); expect(draft.result.summary).toBeNull();
    await generatePayslips(ctx, { batchId: f.current.batchId });
    expect((await run(f.report.id)).result).toMatchObject({ available: true, provisional: true });
    await createIndividualTxn(ctx, {
      batchId: f.current.batchId, employmentId: f.employee.employmentId,
      kind: 'earning', txnDate: currentPeriod + '-01', amount: 1,
    });
    const stale = await run(f.report.id, 'export');
    expect(stale.result.available).toBe(false); expect(stale.result.issues.map(issue => issue.code)).toContain('stalePayroll');
    expect(stale.result.rows).toEqual([]); expect(stale.result.summary).toBeNull();
  });

  it('distinguishes legacy item provenance from zero even when generated Basic is available', async () => {
    const f = await fixture(); await closeBatch(ctx, { batchId: f.previous.batchId });
    await generatePayslips(ctx, { batchId: f.current.batchId });
    expect((await run(f.report.id)).result.available).toBe(true);
    const saved = await getCustomReport(ctx, f.report.id, [b.companyId]); expect(saved).not.toBeNull();
    const spec = structuredClone(saved!.spec); spec.payrollComparison!.payItemCode = 'UNRECORDED_ITEM';
    await updateCustomReport(ctx, { id: saved!.id, name: saved!.name, version: saved!.version, spec, companyIds: [b.companyId] });
    const comparison = await run(f.report.id);
    expect(comparison.result.available).toBe(false);
    expect(comparison.result.issues).toHaveLength(2);
    expect(comparison.result.issues.every(issue => issue.code === 'itemNotRecorded')).toBe(true);
    expect(comparison.result.rows).toEqual([]); expect(comparison.result.summary).toBeNull();
  });

  it('enforces private ownership, saved export verbs, current salary permission and tenant scope on real results', async () => {
    const f = await fixture(); await closeBatch(ctx, { batchId: f.previous.batchId });
    await generatePayslips(ctx, { batchId: f.current.batchId });
    const [user] = await owner.db.insert(s.appUser).values({ tenantId: b.tenantId, workosUserId: 'comparison-' + randomUUID() }).returning({ id: s.appUser.id });
    await owner.db.insert(s.roleAssignment).values({ tenantId: b.tenantId, appUserId: user.id, role: 'hr_admin' });
    const peer = { ...ctx, userId: user.id };
    expect(await getCustomReport(peer, f.report.id, [b.companyId])).toBeNull();
    await expect(run(f.report.id, 'view', peer)).rejects.toThrow();
    await expect(run(f.report.id, 'export', peer)).rejects.toThrow();
    const saved = await getCustomReport(ctx, f.report.id, [b.companyId]); expect(saved).not.toBeNull();
    const spec = structuredClone(saved!.spec);
    spec.layout = { ...spec.layout, permissions: { hr_admin: ['view', 'create', 'edit', 'delete', 'share'] } };
    await updateCustomReport(ctx, { id: saved!.id, name: saved!.name, version: saved!.version, shared: true, spec, companyIds: [b.companyId] });
    const sharedView=await run(f.report.id, 'view', peer);
    expect(sharedView.result.available).toBe(true);expect(sharedView.canExport).toBe(false);
    await expect(run(f.report.id, 'export', peer)).rejects.toThrow();
    const before = await payrollSnapshot();
    await setPayrollPermissionGrant(ctx, { companyId: b.companyId, permissionKey: 'report.read.compensation', role: 'hr_admin', allowed: false });
    await expect(run(f.report.id, 'view', peer)).rejects.toThrow();
    await expect(run(f.report.id, 'export')).rejects.toThrow();
    const foreign = await seedBase();
    await expect(runPayrollComparisonReport(ctx, [foreign.companyId], { id: f.report.id, filters: { currentPeriod, previousPeriod } })).rejects.toThrow();
    expect(await payrollSnapshot()).toEqual(before);
  });
});
