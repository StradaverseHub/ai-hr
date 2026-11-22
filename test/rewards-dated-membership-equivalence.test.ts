import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBusinessUnit } from '../core/admin';
import { companyOrganisationRunReport, decideCompanyOrganisationRun, prepareCompanyOrganisationRun, processCompanyOrganisationRun } from '../core/company-organisation';
import { hireEmployee, transferEmploymentCompanyTx } from '../core/org';
import { setLabelGlobal } from '../core/system-labels';
import { withTenant, type SessionContext } from '../db/client';
import { company, department, roleAssignment } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { compareRewardsRosterMembership } from '../scripts/performance/rewards-roster-membership-comparison.mjs';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

const nativeSources = {
  'core/module-gate.ts': () => import('../core/module-gate'),
  'core/employment-company.ts': () => import('../core/employment-company'),
  'core/personnel-quality.ts': () => import('../core/personnel-quality'),
};
const getSource = (path: keyof typeof nativeSources) => nativeSources[path]();
const ready = (employmentId: string, companyId: string) => ({ employmentId, companyId, ready: true, reason: null });
const pending = (employmentId: string, companyId: string) => ({
  employmentId, companyId, ready: false, reason: 'company_not_in_structure',
});

it('keeps legacy, pending, transferred, and inaccessible Rewards roster candidates equivalent', async () => {
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'rewards', 'active');
  const group = await entitledCtx(base);
  const checker = { ...group, userId: await createAppUser(base.tenantId, null, 'hr_admin') };
  const [destination] = await owner.db.insert(company).values({
    tenantId: base.tenantId, legalName: 'Fictional destination company', country: 'MY', currency: 'MYR',
  }).returning();
  const [destinationDepartment] = await owner.db.insert(department).values({
    tenantId: base.tenantId, companyId: destination.id, name: 'FIC-DEST', label: 'Fictional destination department',
  }).returning();
  const originUnit = await createBusinessUnit(group, { companyId: base.companyId, code: 'FIC-ORIGIN', name: 'Fictional origin unit' });
  await setLabelGlobal(group, { kind: 'business_unit', labelId: originUnit.id, isGlobal: true });
  const destinationUnit = await createBusinessUnit(group, { companyId: destination.id, code: 'FIC-DEST', name: 'Fictional destination unit' });
  const hire = (name: string, companyId: string, departmentId: string, businessUnitId: string) => hireEmployee(group, {
    person: { fullName: name, primaryEmail: randomUUID() + '@fixture.test' },
    companyId, departmentId, businessUnitId, employmentType: 'full_time', hiredOn: '2024-01-01',
  });
  const stays = await hire('Fictional retained origin worker', base.companyId, base.deptA, originUnit.id);
  const moves = await hire('Fictional transferred worker', base.companyId, base.deptA, originUnit.id);
  const inDestination = await hire('Fictional unmapped worker', destination.id, destinationDepartment.id, destinationUnit.id);

  const check = (context: SessionContext, companyId: string, businessUnitId: string, snapshotDate: string,
    expectedEmploymentIds: string[], expectedReadiness: Array<ReturnType<typeof ready> | ReturnType<typeof pending>>) =>
    compareRewardsRosterMembership(getSource, context, {
      companyId, businessUnitId, snapshotDate, expectedEmploymentIds, expectedReadiness, repeat: 1,
    });

  await withTenant(group, tx => transferEmploymentCompanyTx(tx, group, {
    employmentId: moves.employmentId, newCompanyId: destination.id, effectiveDate: '2025-01-15',
    placement: { departmentId: destinationDepartment.id, positionId: null, businessUnitId: destinationUnit.id, locationId: null, managerEmploymentId: null },
    movement: { type: 'entityTransfer', groupId: randomUUID() },
  }));
  await check(group, base.companyId, originUnit.id, '2025-01-14',
    [stays.employmentId, moves.employmentId], [ready(stays.employmentId, base.companyId), ready(moves.employmentId, base.companyId)]);
  await check(group, base.companyId, originUnit.id, '2025-01-15',
    [stays.employmentId], [ready(stays.employmentId, base.companyId)]);
  await check(group, destination.id, destinationUnit.id, '2025-01-15',
    [inDestination.employmentId, moves.employmentId], [ready(inDestination.employmentId, destination.id), ready(moves.employmentId, destination.id)]);

  const today = todayInKualaLumpur();
  const runId = await prepareCompanyOrganisationRun(group, {
    kind: 'mapping', companyIds: [base.companyId], effectiveOn: today,
    changes: [{ companyId: base.companyId, businessUnitId: originUnit.id, parentCompanyId: null }],
  });
  const { run } = await companyOrganisationRunReport(checker, runId);
  await decideCompanyOrganisationRun(checker, { id: runId, digest: run.digest, approve: true, reason: 'Reviewed fictional origin company mapping' });
  expect((await companyOrganisationRunReport(group, runId)).run.state).toBe('approved');
  let result = await processCompanyOrganisationRun(group, runId);
  for (let attempts=0; result.state==='staging' && attempts<20; attempts++) {
    result = await processCompanyOrganisationRun(group, runId);
  }
  expect(result.state).toBe('published');

  await check(group, destination.id, destinationUnit.id, today, [],
    [pending(inDestination.employmentId, destination.id), pending(moves.employmentId, destination.id)]);
  await check(group, base.companyId, originUnit.id, today, [stays.employmentId], [ready(stays.employmentId, base.companyId)]);

  const scopedUser = await createAppUser(base.tenantId, null, 'hr_admin');
  await owner.db.update(roleAssignment).set({ companyId: base.companyId }).where(eq(roleAssignment.appUserId, scopedUser));
  const scoped = { ...group, userId: scopedUser, grants: [{ role: 'hr_admin', companyId: base.companyId }] };
  await check(scoped, base.companyId, originUnit.id, today, [stays.employmentId], [ready(stays.employmentId, base.companyId)]);
  await check(scoped, destination.id, destinationUnit.id, today, [], []);

  const foreign = await seedBase();
  await setModule(foreign.tenantId, 'rewards', 'active');
  await check(await entitledCtx(foreign), base.companyId, originUnit.id, today, [], []);
}, 120_000);
