import { performance } from 'node:perf_hooks';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { withScopedLifecycleTenant } from '../core/module-gate';
import { withIndependentTransactions, type SessionContext } from '../db/client';
import type { SharedReadStats } from '../db/shared-read';
import { employment } from '../db/schema';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { defaultConfig } from '../lib/onboarding-model';
import { readShellNavigationContext, readSignedInShellNavigation } from '../lib/shell-navigation-context';
import { readShellFeatureNavigation } from '../lib/shell-feature-navigation';
import { offboardingPostingAccess } from '../packs/personnel-postings/service';
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

it('measures the native Offboarding Postings access check under real group and company grants', async () => {
  const { group: groupAdmin, single, multi } = group.personas;
  const { tenantId, userId } = groupAdmin;
  if (!userId || !single.userId) throw new Error('The approver fixtures require persisted app users');
  const onboarding = defaultConfig(userId);
  const lifecycle = v9Defaults(onboarding.groups);
  const approvers = { id: 'scale-posting-approvers', name: 'Posting approvers', members: [userId, single.userId], limit: 0 };
  onboarding.groups.push(approvers);
  lifecycle.groups.push(approvers);
  lifecycle.offboarding = { ...lifecycle.offboarding, postingApproverGroupId: approvers.id };
  await owner.db.execute(sql`
    insert into lc_onboarding_config(tenant_id, revision, data)
    values (${tenantId}::uuid, 1, ${JSON.stringify(onboarding)}::jsonb)
    on conflict (tenant_id) do update set data=excluded.data, revision=excluded.revision
  `);
  await owner.db.execute(sql`
    insert into lc_v9_config(tenant_id, revision, data)
    values (${tenantId}::uuid, ${lifecycle.revision}, ${JSON.stringify(lifecycle)}::jsonb)
    on conflict (tenant_id) do update set data=excluded.data, revision=excluded.revision
  `);
  const actors = [
    { name: 'group-approver', session: groupAdmin, allowed: true },
    { name: 'company-approver', session: single, allowed: true },
    { name: 'hr-outside-approver-group', session: multi, allowed: false },
    { name: 'employee', session: employee, allowed: false },
  ];
  const hooks = globalThis as {
    __aihrPerfBeginTransaction?: (poolMax: number) => { acquired: () => void; finished: () => void };
  };
  const previousHook = hooks.__aihrPerfBeginTransaction;
  try {
    for (const { name, session, allowed } of actors) {
      expect(await offboardingPostingAccess(session), name).toBe(allowed);
      const samples = [];
      for (let trial = 0; trial < 6; trial++) {
        let acquiredAt = Number.NaN;
        hooks.__aihrPerfBeginTransaction = () => ({
          acquired: () => { acquiredAt = performance.now(); },
          finished: () => {},
        });
        const startedAt = performance.now();
        const result = await withScopedLifecycleTenant(session, async tx => {
          const queryAt = performance.now();
          const [row] = await tx.execute<{ ok: boolean }>(sql`select app.offboarding_posting_queue_access() as ok`);
          return { allowed: row?.ok, queryAt, queryReturnedAt: performance.now() };
        });
        expect(result.allowed, name).toBe(allowed);
        expect(acquiredAt).toBeGreaterThanOrEqual(startedAt);
        samples.push({
          transactionEntryMs: acquiredAt - startedAt,
          tenantBootstrapMs: result.queryAt - acquiredAt,
          statementRoundTripMs: result.queryReturnedAt - result.queryAt,
          totalMs: performance.now() - startedAt,
        });
      }
      console.info('OFFBOARDING_NATIVE_PROFILE', JSON.stringify({ name, allowed, samples }));
    }
  } finally {
    hooks.__aihrPerfBeginTransaction = previousHook;
  }
});
