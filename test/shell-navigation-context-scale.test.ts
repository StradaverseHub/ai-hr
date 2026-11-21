import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { lifecycleModuleNavigation } from '../app/lifecycle/workflow-availability';
import { readShellLifecyclePreview } from '../app/lifecycle/module-inbox';
import { isModuleEnabledOrFalse } from '../core/entitlements';
import { withIndependentTransactions, type SessionContext } from '../db/client';
import type { SharedReadStats } from '../db/shared-read';
import { appExternalIdentity, deploymentIdentityOperator, employment } from '../db/schema';
import { canAdminOnehr } from '../lib/authz-model';
import { readShellNavigationContext, readSignedInShellNavigation, readSignedInShellRail } from '../lib/shell-navigation-context';
import {canConfigureIdentityEmail} from '../lib/identity/email-settings';
import { readShellFeatureNavigation } from '../lib/shell-feature-navigation';
import { withRequestReadScope } from '../lib/request-read-scope';
import { onboardingNavigation } from '../packs/lifecycle/service';
import { adminSectionHref, latestOnehrAdminCycleId } from '../packs/performance/service';
import { offboardingPostingAccess } from '../packs/personnel-postings/service';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';

const browser = vi.hoisted(() => ({
  companyScope: undefined as string | undefined,
  identity: null as {issuer:string;subject:string;email:string;emailVerified:boolean}|null,
}));
vi.mock('../lib/identity/provider',()=>({currentProviderSession:async()=>browser.identity}));
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
  for (const module of ['assistant', 'rewards', 'recruitment', 'lifecycle', 'performance']) {
    await setModule(base.tenantId, module, 'active');
  }
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
      expect(shared).toEqual({ context, features, identityEmailAvailable: false });
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

it('keeps all rail destinations while avoiding separate Lifecycle and Performance transactions', async () => {
  const cases = [
    { session: group.personas.group, companyScope: undefined },
    { session: group.personas.group, companyScope: group.singleCompanyId },
    { session: group.personas.multi, companyScope: undefined },
    { session: group.personas.single, companyScope: group.singleCompanyId },
    { session: employee, companyScope: undefined },
  ];
  const hooks = globalThis as {
    __aihrPerfBeginTransaction?: () => { acquired: () => void; finished: () => void };
  };
  const previousHook = hooks.__aihrPerfBeginTransaction;
  let opened = 0;
  hooks.__aihrPerfBeginTransaction = () => ({ acquired: () => { opened++; }, finished: () => {} });
  try {
    for (const { session, companyScope } of cases) {
      browser.companyScope = companyScope;
      expect(isModuleEnabledOrFalse(session, 'lifecycle')).toBe(true);
      opened = 0;
      const navigation = await readSignedInShellNavigation(session);
      const [onboardingNav, scopedLifecycleNavigation, offboardingPostingsAccess, cycle] = await Promise.all([
        onboardingNavigation(session),
        lifecycleModuleNavigation(session),
        offboardingPostingAccess(session),
        canAdminOnehr(session) ? latestOnehrAdminCycleId(session) : null,
      ]);
      const separateTransactions = opened;
      opened = 0;
      expect(await readSignedInShellRail(session)).toEqual({
        ...navigation,
        lifecycleEnabled: true,
        onboardingNav,
        scopedLifecycleNavigation,
        offboardingPostingsAccess,
        performanceAdminPath: cycle ? adminSectionHref(cycle, 'cycle') : undefined,
      });
      expect(opened).toBe(1);
      expect(separateTransactions).toBeGreaterThan(opened);
    }
  } finally {
    browser.companyScope = undefined;
    hooks.__aihrPerfBeginTransaction = previousHook;
  }
});

it('keeps Lifecycle preview results while sharing compatible reads inside one render', async () => {
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
      const independent = await withIndependentTransactions(() => readShellLifecyclePreview(session, true, navigation));
      const separateTransactions = opened;
      opened = 0;
      const shared = await withRequestReadScope({}, () => readShellLifecyclePreview(session, true, navigation));
      expect(shared).toEqual(independent);
      expect(opened).toBeGreaterThanOrEqual(2);
      expect(opened).toBeLessThan(separateTransactions);
    }
  } finally {
    hooks.__aihrPerfBeginTransaction = previousHook;
  }
});

it('reuses the shell connection for current enrolled email operator authority', async()=>{
  const current=group.personas.group;
  if(!current.userId)throw Error('Missing group HR app identity');
  const authorized={issuer:'https://fixture.test/auth',subject:'enrolled-operator',email:'operator@example.test',emailVerified:true};
  await owner.db.insert(appExternalIdentity).values({
    issuer:authorized.issuer,subject:authorized.subject,appUserId:current.userId,
  });
  await owner.db.insert(deploymentIdentityOperator).values({
    issuer:authorized.issuer,subject:authorized.subject,testEmail:authorized.email,
  });
  vi.stubEnv('AUTH_PROVIDER','internal');
  browser.identity=authorized;
  const hooks=globalThis as {__aihrPerfBeginTransaction?:()=>{acquired:()=>void;finished:()=>void}};
  const previous=hooks.__aihrPerfBeginTransaction;
  let opened=0;
  hooks.__aihrPerfBeginTransaction=()=>({acquired:()=>{opened++;},finished:()=>{}});
  try {
    expect((await readSignedInShellNavigation(current)).identityEmailAvailable).toBe(true);
    expect(opened).toBe(1);
    expect(await canConfigureIdentityEmail(current)).toBe(true);
    expect(opened).toBe(2);
    expect((await readSignedInShellNavigation(group.personas.single)).identityEmailAvailable).toBe(false);
    browser.identity={...authorized,email:'changed@example.test'};
    expect((await readSignedInShellNavigation(current)).identityEmailAvailable).toBe(false);
    browser.identity=authorized;
    await owner.db.update(deploymentIdentityOperator).set({revokedAt:new Date()})
      .where(eq(deploymentIdentityOperator.subject,authorized.subject));
    expect((await readSignedInShellNavigation(current)).identityEmailAvailable).toBe(false);
  } finally {
    hooks.__aihrPerfBeginTransaction=previous;
    browser.identity=null;
    vi.unstubAllEnvs();
  }
}, 90_000);
