import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { withIndependentTransactions, type SessionContext } from '../db/client';
import type { SharedReadStats } from '../db/shared-read';
import { appExternalIdentity, deploymentIdentityOperator, employment } from '../db/schema';
import { readShellNavigationContext, readSignedInShellNavigation } from '../lib/shell-navigation-context';
import {canConfigureIdentityEmail} from '../lib/identity/email-settings';
import { readShellFeatureNavigation } from '../lib/shell-feature-navigation';
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
  for (const module of ['assistant', 'rewards', 'recruitment']) await setModule(base.tenantId, module, 'active');
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
