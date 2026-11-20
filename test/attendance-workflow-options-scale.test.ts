import { afterAll, expect, it } from 'vitest';
import {
  attendanceApplicationFilterOptions,
  attendanceNewWorkflowOptions,
  attendanceWorkflowCompanyOptions,
} from '../core/attendance-application-history';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, migrateTestDb, resetDb, seedBase } from './harness';

afterAll(closeAll);

it('keeps workflow options and order at group scale and within one authorized company', async () => {
  await migrateTestDb();
  await resetDb();
  const shape = await buildScaleFixture(await seedBase(), { employments: 1000, events: 0 });
  expect(shape.companyIds).toHaveLength(71);
  expect(shape.employmentIds).toHaveLength(1000);
  for (const { session, requested, expected } of [
    { session: shape.personas.group, requested: shape.companyIds, expected: shape.companyIds },
    { session: shape.personas.single, requested: shape.operatingCompanyIds, expected: [shape.singleCompanyId] },
  ]) {
    const baseline = await attendanceApplicationFilterOptions(session, requested);
    const { approverEmployees, approverAvailability: _availability, ...formFields } = baseline;
    const labels = await attendanceWorkflowCompanyOptions(session, requested);
    expect(labels).toEqual(baseline.companies);
    expect(labels.map(row => row.id).sort()).toEqual([...expected].sort());
    expect(baseline.employees.length).toBeGreaterThan(0);
    const create = await attendanceNewWorkflowOptions(session, requested);
    expect(create).toEqual(formFields);
    expect(create).not.toHaveProperty('approverEmployees');
    expect(create).not.toHaveProperty('approverAvailability');
    expect(approverEmployees).toBeDefined();
  }
// The group baseline intentionally resolves the expensive directory before comparing it.
}, 120000);
