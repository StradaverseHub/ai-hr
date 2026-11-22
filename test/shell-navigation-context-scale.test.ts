import { eq } from 'drizzle-orm';
import { lifecycleModuleInbox } from '../app/lifecycle/module-inbox';
import { lifecycleModuleNavigation } from '../app/lifecycle/workflow-availability';
import { withRequestReadScope } from '../lib/request-read-scope';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { withIndependentTransactions, type SessionContext } from '../db/client';
import type { SharedReadStats } from '../db/shared-read';
import { employment } from '../db/schema';
import { readShellNavigationContext, readSignedInShellNavigation } from '../lib/shell-navigation-context';
import { readShellFeatureNavigation } from '../lib/shell-feature-navigation';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('next-intl/server')>(),
  getTranslations: async () => (key: string) => key,
}));

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
  for (const module of ['assistant', 'rewards', 'recruitment', 'lifecycle']) await setModule(base.tenantId, module, 'active');
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

it('keeps shell identity, scope and features equivalent on one connection at group scale', async () => {
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
      const context = await readShellNavigationContext(session);
      const features = await readShellFeatureNavigation(session, context[0].scopeIds);
      expect(proof).toHaveLength(2);
      expect(proof.map(snapshot => snapshot.carriers)).toEqual([1, 1]);
      proof.length = 0;

      const shared = await readSignedInShellNavigation(session);
      const independent = await withIndependentTransactions(() => readSignedInShellNavigation(session));
      expect(shared).toEqual({ context, features });
      expect(shared).toEqual(independent);
      const [companies, viewer] = shared.context;
      expect([...companies.scopeIds].sort()).toEqual([...expected].sort());
      expect(viewer.name).toBeTruthy();
      expect(viewer.employed).toBe(true);
      expect(proof).toHaveLength(1);
      expect(proof[0]).toMatchObject({ carriers: 1, fallbacks: 0 });
      expect(proof[0].joins).toBeGreaterThanOrEqual(8);
    }
  } finally {
    browser.companyScope = undefined;
    hooks.__aihrPerfSharedRead = oldHook;
  }
});

it('retains native Lifecycle inbox results while sharing compatible reads at group scale', async () => {
  const hooks = globalThis as {
    __aihrPerfBeginTransaction?: () => { acquired: () => void; finished: () => void };
  };
  const previousHook = hooks.__aihrPerfBeginTransaction;
  let opened = 0;
  hooks.__aihrPerfBeginTransaction = () => ({ acquired: () => { opened++; }, finished: () => {} });
  try {
    for (const session of [group.personas.group, group.personas.single, employee]) {
      const navigation = await lifecycleModuleNavigation(session);
      opened = 0;
      const independent = await withIndependentTransactions(() => lifecycleModuleInbox(session, navigation));
      const separateTransactions = opened;
      opened = 0;
      const shared = await withRequestReadScope({}, () => lifecycleModuleInbox(session, navigation));
      expect(shared).toEqual(independent);
      expect(opened).toBeGreaterThanOrEqual(2);
      expect(opened).toBeLessThan(separateTransactions);
    }
  } finally {
    hooks.__aihrPerfBeginTransaction = previousHook;
  }
});
