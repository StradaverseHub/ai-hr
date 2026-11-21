import { performance } from 'node:perf_hooks';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { client, withIndependentTransactions, withSharedReadSnapshot, type SessionContext } from '../db/client';
import { lifecycleModuleNavigation } from '../app/lifecycle/workflow-availability';
import { onboardingNavigation } from '../packs/lifecycle/service';
import { offboardingPostingAccess } from '../packs/personnel-postings/service';
import type { SharedReadStats } from '../db/shared-read';
import { employment } from '../db/schema';
import { readShellNavigationContext, readSignedInShellNavigation } from '../lib/shell-navigation-context';
import { readShellFeatureNavigation } from '../lib/shell-feature-navigation';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';
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
      hooks.__aihrPerfSharedRead = undefined;
      const [onboardingNav, scopedLifecycleNavigation, offboardingPostingsAccess] = await Promise.all([
        onboardingNavigation(session),
        lifecycleModuleNavigation(session),
        offboardingPostingAccess(session).catch(() => false),
      ]);
      expect(shared).toEqual({
        context, features, lifecycleEnabled: true, onboardingNav, scopedLifecycleNavigation, offboardingPostingsAccess,
      });
      expect(shared).toEqual(independent);
      const [companies, viewer] = shared.context;
      expect([...companies.scopeIds].sort()).toEqual([...expected].sort());
      expect(viewer.name).toBeTruthy();
      expect(viewer.employed).toBe(true);
      expect(proof).toHaveLength(1);
      expect(proof[0]).toMatchObject({ carriers: 1, fallbacks: 0 });
      expect(proof[0].joins).toBeGreaterThanOrEqual(12);
    }
  } finally {
    browser.companyScope = undefined;
    hooks.__aihrPerfSharedRead = oldHook;
  }
});


it('compares split and combined signed-in reads on the same host', async () => {
  browser.companyScope = undefined;
  // All four roles in this fixture have Lifecycle enabled. Reproduce the two
  // original startup phases, holding the owners and fixture constant.
  const readSplit = async (session: SessionContext) => {
    const shell = await withSharedReadSnapshot(session, async () => {
      const context = await readShellNavigationContext(session);
      const features = await readShellFeatureNavigation(session, context[0].scopeIds);
      return { context, features };
    });
    const [onboardingNav, scopedLifecycleNavigation, offboardingPostingsAccess] = await Promise.all([
      onboardingNavigation(session),
      lifecycleModuleNavigation(session),
      offboardingPostingAccess(session).catch(() => false),
    ]);
    return { ...shell, lifecycleEnabled: true, onboardingNav, scopedLifecycleNavigation, offboardingPostingsAccess };
  };
  const readers = { split: readSplit, combined: readSignedInShellNavigation };
  const roles = [group.personas.group, group.personas.single, group.personas.multi, employee];
  const results = [];
  for (const size of [1, 4, 12]) {
    const sessions = Array.from({ length: size }, (_, index) => roles[index % roles.length]);
    const run = (design: keyof typeof readers) => Promise.all(sessions.map(session => readers[design](session)));
    expect(await run('combined')).toEqual(await run('split'));
    const samples = { split: [] as number[], combined: [] as number[] };
    const statements = { split: [] as number[], combined: [] as number[] };
    for (let pair = 0; pair < 8; pair++) {
      let split, combined;
      for (const design of pair % 2 ? ['combined', 'split'] as const : ['split', 'combined'] as const) {
        const prior = client.options.debug;
        let count = 0;
        client.options.debug = () => { count++; };
        const started = performance.now();
        try {
          const value = await run(design);
          samples[design].push(performance.now() - started);
          statements[design].push(count);
          if (design === 'split') split = value;
          else combined = value;
        } finally {
          client.options.debug = prior;
        }
      }
      expect(combined).toEqual(split);
    }
    const median = (values: number[]) => {
      const ordered = [...values].sort((a, b) => a - b);
      return Math.round((ordered[3] + ordered[4]) * 50) / 100;
    };
    results.push({
      concurrentRequests: size, pairs: samples.split.length,
      splitMedianMs: median(samples.split), combinedMedianMs: median(samples.combined),
      splitMedianStatements: median(statements.split), combinedMedianStatements: median(statements.combined),
    });
  }
  console.info('SHELL_STARTUP_SAME_RUNNER ' + JSON.stringify(results));
}, 120000);
