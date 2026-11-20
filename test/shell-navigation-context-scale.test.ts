import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { withIndependentTransactions, type SessionContext } from '../db/client';
import type { SharedReadStats } from '../db/shared-read';
import { employment } from '../db/schema';
import { readShellNavigationContext } from '../lib/shell-navigation-context';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase } from './harness';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';

const browser = vi.hoisted(() => ({ companyScope: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => name === 'company_scope' && browser.companyScope
      ? { value: browser.companyScope }
      : undefined,
  }),
}));

let group: ScaleFixture;
let employee: SessionContext;
let employeeCompanyId: string;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  group = await buildScaleFixture(base, { employments: 1000, events: 0 });
  const [staff] = await owner.db
    .select({ personId: employment.personId, companyId: employment.companyId })
    .from(employment)
    .where(eq(employment.id, group.activeEmploymentIds[0]));
  employeeCompanyId = staff.companyId;
  const userId = await createAppUser(base.tenantId, staff.personId, 'employee');
  employee = {
    ...await entitledCtx(base, ['employee']),
    userId,
    personId: staff.personId,
    roles: ['employee'],
    grants: [{ role: 'employee', companyId: null }],
  };
}, 90000);
afterAll(closeAll);

it('keeps group, selected company and scoped roles equivalent on one shell read connection', async () => {
  expect(group.companyIds).toHaveLength(71);
  expect(group.employmentIds).toHaveLength(1000);
  const cases = [
    { session: group.personas.group, selection: undefined, expected: group.companyIds },
    { session: group.personas.group, selection: group.singleCompanyId, expected: [group.singleCompanyId] },
    { session: group.personas.multi, selection: undefined, expected: group.companyIds },
    { session: group.personas.single, selection: undefined, expected: [group.companyIds[0], group.singleCompanyId] },
    { session: group.personas.single, selection: group.singleCompanyId, expected: [group.singleCompanyId] },
    { session: employee, selection: undefined, expected: [employeeCompanyId] },
  ];
  const hooks = globalThis as { __aihrPerfSharedRead?: (stats: SharedReadStats) => void };
  const oldHook = hooks.__aihrPerfSharedRead;
  try {
    for (const { session, selection, expected } of cases) {
      browser.companyScope = selection;
      const proof: SharedReadStats[] = [];
      hooks.__aihrPerfSharedRead = stats => { proof.push(stats); };
      const shared = await readShellNavigationContext(session);
      const independent = await withIndependentTransactions(() => readShellNavigationContext(session));
      expect(shared).toEqual(independent);
      const [companies, viewer] = shared;
      expect([...companies.scopeIds].sort()).toEqual([...expected].sort());
      expect(viewer.name).toBeTruthy();
      expect(viewer.employed).toBe(true);
      expect(proof).toHaveLength(1);
      expect(proof[0]).toMatchObject({ carriers: 1, joins: 3, fallbacks: 0 });
    }
  } finally {
    browser.companyScope = undefined;
    hooks.__aihrPerfSharedRead = oldHook;
  }
});
