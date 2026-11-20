import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withIndependentTransactions, type SessionContext } from '../db/client';
import { employment } from '../db/schema';
import type { SharedReadStats } from '../db/shared-read';
import { readShellFeatureNavigation } from '../lib/shell-feature-navigation';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

let group: ScaleFixture;
let employee: SessionContext;
let employeeCompanyId: string;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  for (const module of ['assistant', 'rewards', 'recruitment']) await setModule(base.tenantId, module, 'active');
  group = await buildScaleFixture(base, { employments: 1000, events: 0 });
  const [staff] = await owner.db.select({ personId: employment.personId, companyId: employment.companyId })
    .from(employment).where(eq(employment.id, group.activeEmploymentIds[0]));
  employeeCompanyId = staff.companyId;
  employee = {
    ...await entitledCtx(base, ['employee']),
    userId: await createAppUser(base.tenantId, staff.personId, 'employee'),
    personId: staff.personId,
    grants: [{ role: 'employee', companyId: null }],
  };
}, 90000);
afterAll(closeAll);

it('resolves the same feature permissions on one authenticated snapshot at group scale', async () => {
  expect(group.companyIds).toHaveLength(71);
  expect(group.employmentIds).toHaveLength(1000);
  const cases = [
    { session: group.personas.group, ids: group.companyIds, showsLetters: true },
    { session: group.personas.group, ids: [group.singleCompanyId], showsLetters: true },
    { session: group.personas.single, ids: [group.singleCompanyId], showsLetters: true },
    { session: employee, ids: [employeeCompanyId], showsLetters: false },
  ];
  const hooks = globalThis as { __aihrPerfSharedRead?: (stats: SharedReadStats) => void };
  const previous = hooks.__aihrPerfSharedRead;
  try {
    for (const { session, ids, showsLetters } of cases) {
      const reports: SharedReadStats[] = [];
      hooks.__aihrPerfSharedRead = stats => { reports.push(stats); };
      const shared = await readShellFeatureNavigation(session, ids);
      const baseline = await withIndependentTransactions(() => readShellFeatureNavigation(session, ids));
      expect(shared).toEqual(baseline);
      const letterDestinations: readonly string[] = shared.letters;
      expect(letterDestinations.includes('/letters/register')).toBe(showsLetters);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ carriers: 1, fallbacks: 0 });
      expect(reports[0].joins).toBeGreaterThanOrEqual(5);
    }
  } finally {
    hooks.__aihrPerfSharedRead = previous;
  }
}, 90000);
