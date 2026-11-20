import { afterAll, expect, it } from 'vitest';
import { attendanceWorkflowCompanyLabels, attendanceWorkflowCreationCompanies } from '../app/admin/attendance/approval-workflow/company-labels';
import { attendanceApplicationFilterOptions } from '../packs/attendance/service';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, migrateTestDb, resetDb, seedBase } from './harness';

afterAll(closeAll);

it('preserves workflow company labels and scope without fetching employee or approver options', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  const foreign = await seedBase();
  const group = await buildScaleFixture(base, { employments: 1000, events: 0 });
  expect(group.companyIds).toHaveLength(71);
  expect(group.employmentIds).toHaveLength(1000);
  const cases = [
    { session: group.personas.group, scope: [...group.companyIds, foreign.companyId] },
    { session: group.personas.group, scope: [group.singleCompanyId] },
    { session: group.personas.single, scope: [...group.companyIds, foreign.companyId] },
    { session: group.personas.single, scope: [] },
  ];
  for (const { session, scope } of cases) {
    const previous = await attendanceApplicationFilterOptions(session, scope);
    const labels = await attendanceWorkflowCompanyLabels(session, scope);
    expect(labels).toEqual(previous.companies);
    expect(labels.some(({ id }) => id === foreign.companyId)).toBe(false);
    expect(await attendanceWorkflowCreationCompanies(session, scope)).toEqual({
      companies: previous.companies, canManageAllCompanies: previous.canManageAllCompanies === true,
    });
  }
}, 120000);
