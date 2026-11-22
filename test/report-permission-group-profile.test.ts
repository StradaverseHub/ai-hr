import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { MASTER_REPORT_CATEGORIES, masterReportFieldsTx } from '../core/employee-master-access';
import { personnelFormulaPermissionsTx } from '../core/pay-formula-personnel-permissions';
import { payrollComparisonAccessTx } from '../core/report-payroll-access';
import { payrollComparisonSpec } from '../core/report-payroll-comparison';
import { resolvePayrollPermission } from '../packs/payroll/service';
import type { PayrollPermissionKey } from '../lib/payroll-permissions';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

const permissionKeys = MASTER_REPORT_CATEGORIES.map(
  (category): PayrollPermissionKey => `report.read.${category}`,
);

async function measure<T>(run: () => Promise<T>) {
  const started = performance.now();
  const result = await run();
  return { result, elapsedMs: Math.round(performance.now() - started) };
}

async function comparePermissions(actor: SessionContext, companyIds: string[]) {
  return withTenant(actor, async (tx) => {
    const native = await measure(async () => {
      const admitted = new Map(permissionKeys.map((key) => [key, new Set<string>()]));
      for (const companyId of companyIds) {
        for (const key of permissionKeys) {
          if (await resolvePayrollPermission(tx, actor, key, companyId)) admitted.get(key)!.add(companyId);
        }
      }
      return admitted;
    });
    const batched = await measure(() => personnelFormulaPermissionsTx(tx, actor, companyIds, permissionKeys));
    expect(batched.result).toEqual(native.result);
    return {
      admitted: native.result,
      nativeMs: native.elapsedMs,
      batchedMs: batched.elapsedMs,
    };
  }, { readOnlySnapshot: true });
}

it('compares native and batched report grants on a populated group', async () => {
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'payroll', 'active');
  const subsidiaryRows = await owner.db.insert(schema.company).values(
    Array.from({ length: 69 }, (_, index) => ({
      tenantId: base.tenantId, legalName: `Fictional report company ${index}`,
    })),
  ).returning({ id: schema.company.id });
  const companyIds = [base.companyId, ...subsidiaryRows.map((row) => row.id)];
  const people = await owner.db.insert(schema.person).values(
    Array.from({ length: 1000 }, (_, index) => ({
      tenantId: base.tenantId, fullName: `Fictional report employee ${index}`,
      primaryEmail: `report-employee-${index}@example.invalid`,
    })),
  ).returning({ id: schema.person.id });
  const employments = await owner.db.insert(schema.employment).values(
    people.map((person, index) => ({
      tenantId: base.tenantId, personId: person.id, companyId: companyIds[index % companyIds.length],
      employeeCode: `REPORT${index}`, hiredOn: '2026-01-01',
    })),
  ).returning({ id: schema.employment.id });
  expect(companyIds).toHaveLength(70);
  expect(employments).toHaveLength(1000);

  const group: SessionContext = {
    ...(await entitledCtx(base)),
    grants: [{ role: 'hr_admin', companyId: null }],
  };
  const companyUser = await createAppUser(base.tenantId, null, 'hr_admin');
  await owner.db.update(schema.roleAssignment).set({ companyId: base.companyId })
    .where(eq(schema.roleAssignment.appUserId, companyUser));
  const company: SessionContext = {
    ...group, userId: companyUser, grants: [{ role: 'hr_admin', companyId: base.companyId }],
  };
  const master = (actor: SessionContext, ids: string[]) =>
    withTenant(actor, (tx) => masterReportFieldsTx(tx, actor, ids), { readOnlySnapshot: true });
  const comparison = (actor: SessionContext, ids: string[]) =>
    withTenant(actor, (tx) => payrollComparisonAccessTx(tx, actor, payrollComparisonSpec(), 'view', ids),
      { readOnlySnapshot: true });
  const groupFields = await measure(() => master(group, companyIds));
  const groupComparison = await measure(() => comparison(group, companyIds));
  const companyFields = await measure(() => master(company, [base.companyId]));
  const companyComparison = await measure(() => comparison(company, [base.companyId]));
  expect(groupFields.result.length).toBeGreaterThan(30);
  expect(groupFields.result.map((field) => field.id)).toEqual(companyFields.result.map((field) => field.id));
  expect(groupComparison.result).toEqual(companyIds);
  expect(companyComparison.result).toEqual([base.companyId]);
  await expect(comparison(company, [companyIds[1]])).rejects.toThrow('Report access');

  await owner.db.insert(schema.payrollPermissionGrant).values([
    { tenantId: base.tenantId, permissionKey: 'report.read.compensation', role: 'hr_admin', companyId: null, allowed: false },
    { tenantId: base.tenantId, permissionKey: 'report.read.compensation', role: 'hr_admin', companyId: base.companyId, allowed: true },
  ]);
  const groupPermissions = await comparePermissions(group, companyIds);
  const companyPermissions = await comparePermissions(company, companyIds.slice(0, 2));
  const narrowedPermissions = await comparePermissions({ ...group, roles: [], grants: [] }, [base.companyId]);
  expect(groupPermissions.admitted.get('report.read.personnel')).toEqual(new Set(companyIds));
  expect(groupPermissions.admitted.get('report.read.compensation')).toEqual(new Set([base.companyId]));
  expect(companyPermissions.admitted.get('report.read.personnel')).toEqual(new Set([base.companyId]));
  expect([...narrowedPermissions.admitted.values()].every((companies) => companies.size === 0)).toBe(true);
  await expect(comparison(group, companyIds)).rejects.toThrow('Report access');
  await expect(comparison(group, [base.companyId])).resolves.toEqual([base.companyId]);

  console.info('Report permission profile', JSON.stringify({
    companies: companyIds.length, employments: employments.length,
    masterGroupMs: groupFields.elapsedMs, masterCompanyMs: companyFields.elapsedMs,
    comparisonGroupMs: groupComparison.elapsedMs, comparisonCompanyMs: companyComparison.elapsedMs,
    groupPermissionNativeMs: groupPermissions.nativeMs, groupPermissionBatchedMs: groupPermissions.batchedMs,
    companyPermissionNativeMs: companyPermissions.nativeMs, companyPermissionBatchedMs: companyPermissions.batchedMs,
  }));
}, 120_000);
