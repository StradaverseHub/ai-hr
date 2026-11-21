/** Profile the actual shared-shell onboarding count with native actors and retained public cases. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { saveEmployeeDraft } from '../core/employee-draft';
import { client, withTenant, type SessionContext } from '../db/client';
import { company, lcOnboardingCase } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { dayDate, visibleRecentJoiner, type Case, type Requisition, type Task } from '../lib/onboarding-model';
import { onboardingContext, onboardingNavigation, onboardingSaveConfig, onboardingSetup } from '../packs/lifecycle/service';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);
afterEach(() => vi.restoreAllMocks());

it('profiles the complete shell DTO and exact admitted recent joiner count', async () => {
  await resetDb();
  const b = await seedBase();
  await setModule(b.tenantId, 'lifecycle', 'active');
  const admin = await entitledCtx(b);
  const today = todayInKualaLumpur();
  await onboardingSetup(admin);
  const ctx = await onboardingContext(admin);
  const memberId = await createAppUser(b.tenantId, null, 'employee');
  const otherId = await createAppUser(b.tenantId, null, 'employee');
  const employeeCtx = await entitledCtx(b, ['employee']);
  const employee = (userId: string): SessionContext => ({ ...employeeCtx, userId, personId: null, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] });
  const config = structuredClone(ctx.config);
  config.recentActiveDays = 14;
  config.access.onboarding.push(memberId);
  await onboardingSaveConfig(admin, ctx.revision, config);
  const [anotherCompany] = await owner.db.insert(company).values({ tenantId: b.tenantId, legalName: 'Fictional second company' }).returning();
  const draft = await saveEmployeeDraft(admin, {
    currentStep: 1,
    data: {
      profile: { fullName: 'Fictional current onboarding draft', primaryEmail: 'nav-count@example.test' },
      employment: { companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, hiredOn: dayDate(today, 8) },
    },
  });
  const [actual] = await owner.db.select().from(lcOnboardingCase).where(eq(lcOnboardingCase.sourceDraftId, draft.id));
  expect(actual.data.personnelStatus).toBe('Draft');
  const cutoff = dayDate(today, -config.recentActiveDays);
  const prior = dayDate(cutoff, -1);
  const req = (cancelledAt: string | null, handedAt: string | null): Requisition => ({
    id: randomUUID(), number: 'Fictional retained requisition', createdAt: '2025-01-01T00:00:00Z',
    cancelledAt, handedAt, items: [], hrNote: '', noteVersion: 1, noteAcks: {},
  });
  const task: Task = {
    id: 'retained-task', name: 'Fictional task', by: 'group', group: 'people-gbs', method: 'rr', opens: null, due: 1, gate: false,
    checklistId: 'retained-checklist', checklistName: 'Fictional checklist', status: 'todo', assignee: null, failure: null,
    assignedAt: null, opensOn: null, dueOn: prior, completedAt: null, completedBy: null,
  };
  const at = '2025-01-01T00:00:00Z';
  const make = (number: string, patch: Partial<Case> = {}, companyId = b.companyId) => {
    const id = randomUUID();
    const data: Case = {
      ...structuredClone(actual.data), id, number, sourceDraftId: null, employmentId: null, personId: null,
      personnelStatus: 'Active', state: 'submitted', source: { joinDate: prior }, local: {}, tasks: [], requisitions: [],
      notes: 'Fictional retained onboarding history. '.repeat(80), ...patch,
    };
    return { id, tenantId: b.tenantId, companyId, data };
  };
  const explicit = [
    [true, make('DRAFT-CANCELLED', { personnelStatus: 'Draft', state: 'cancelled' })],
    [true, make('PENDING-OLD', { state: 'pending' })],
    [true, make('TASK-OPEN', { tasks: [task] })],
    [false, make('TASK-DONE', { tasks: [{ ...task, status: 'done' }] })],
    [false, make('CANCELLED-OLD', { state: 'cancelled', tasks: [task], requisitions: [req(null, null)] })],
    [true, make('EQUIPMENT-OPEN', { requisitions: [req(null, null)] })],
    [false, make('FIRST-HANDED', { requisitions: [req(null, at), req(null, null)] })],
    [true, make('SKIP-FIRST-CANCELLED', { requisitions: [req(at, null), req(null, null)] })],
    [false, make('ALL-CANCELLED', { requisitions: [req(at, null)] })],
    [true, make('EXACT-CUTOFF', { source: { joinDate: cutoff } })],
    [false, make('DAY-BEFORE')],
    [true, make('CANCELLED-RECENT', { state: 'cancelled', source: { joinDate: today } }, anotherCompany.id)],
    [false, make('SOURCE-OLD-WINS', { local: { joinDate: today } })],
    [true, make('SOURCE-NEW-WINS', { source: { joinDate: today }, local: { joinDate: prior } })],
    [true, make('USE-LOCAL-DATE', { source: {}, local: { joinDate: cutoff } })],
    [false, make('SOURCE-EMPTY-WINS', { source: { joinDate: '' }, local: { joinDate: cutoff } })],
    [true, make('FUTURE', { source: { joinDate: dayDate(today, 45) } })],
  ] as const;
  let exactCount = 1; // The real saved Personnel draft remains visible.
  for (const [visible, row] of explicit) {
    expect(visibleRecentJoiner(config, row.data, today), row.data.number).toBe(visible);
    await owner.db.insert(lcOnboardingCase).values(row);
    if (visible) exactCount++;
    expect((await onboardingNavigation(admin)).joiners, row.data.number).toBe(exactCount);
  }
  const retained = Array.from({ length: 1200 }, (_, i) => make(`RETAINED-${i}`));
  for (let offset = 0; offset < retained.length; offset += 150) await owner.db.insert(lcOnboardingCase).values(retained.slice(offset, offset + 150));
  const expected = 1 + explicit.filter(([visible]) => visible).length;
  expect(expected).toBe(11);
  const originalReadStart = performance.now();
  const originalRows = await withTenant(admin, tx => tx.select({ data: lcOnboardingCase.data }).from(lcOnboardingCase).orderBy(lcOnboardingCase.id));
  const originalCount = originalRows.filter(row => visibleRecentJoiner(config, row.data, today)).length;
  const originalReadMs = performance.now() - originalReadStart;
  expect(originalRows).toHaveLength(1218);
  expect(originalCount).toBe(expected);

  const nativeBegin = client.begin.bind(client);
  let capture = true;
  const sqlReads: string[] = [];
  vi.spyOn(client, 'begin').mockImplementation(((...args: unknown[]) => {
    const index = args.findIndex(arg => typeof arg === 'function');
    const callback = args[index] as (native: typeof client) => unknown;
    args[index] = (native: typeof client) => callback(new Proxy(native, { get(target, key, receiver) {
      if (key === 'unsafe') return (...query: unknown[]) => {
        if (capture && typeof query[0] === 'string') sqlReads.push(query[0].toLowerCase());
        return Reflect.apply(target.unsafe, target, query);
      };
      return Reflect.get(target, key, receiver);
    } }));
    return Reflect.apply(nativeBegin, client, args);
  }) as typeof client.begin);
  const start = performance.now();
  const reference = await onboardingNavigation(admin);
  const elapsedMs = performance.now() - start;
  capture = false;
  expect(reference).toEqual({
    module: true, master: true, v9: true, requisitions: true, joiners: expected, checklists: 1,
    v9Navigation: { onboarding: true, offboarding: false, administration: true, records: true },
  });
  const caseReads = sqlReads.filter(text => text.includes('from "lc_onboarding_case"'));
  expect(caseReads).toHaveLength(1);
  expect(caseReads[0]).toContain('select count(*) filter (where evaluated.recent)');
  expect(caseReads[0]).toContain('filter (where evaluated.recent is null) as fallback');
  const aggregateRoundTrips = sqlReads.length;
  expect(await onboardingNavigation(employee(memberId))).toEqual({
    module: true, master: false, v9: false, requisitions: true, joiners: expected, checklists: 1,
    v9Navigation: { onboarding: true, offboarding: false, administration: false, records: true },
  });
  sqlReads.length = 0;
  capture = true;
  const ordinary = await onboardingNavigation(employee(otherId));
  capture = false;
  expect(ordinary).toEqual({
    module: false, master: false, v9: false, requisitions: false, joiners: 0, checklists: 0,
    v9Navigation: { onboarding: false, offboarding: false, administration: false, records: false },
  });
  expect(sqlReads.some(text => text.includes('from "lc_onboarding_case"'))).toBe(false);

  const foreign = await seedBase();
  await setModule(foreign.tenantId, 'lifecycle', 'active');
  const foreignAdmin = await entitledCtx(foreign);
  await onboardingSetup(foreignAdmin);
  expect(await onboardingNavigation(foreignAdmin)).toMatchObject({ module: true, master: true, joiners: 0 });
  const fresh = await onboardingContext(admin);
  fresh.config.access.onboarding = fresh.config.access.onboarding.filter(user => user !== memberId);
  await onboardingSaveConfig(admin, fresh.revision, fresh.config);
  expect(await onboardingNavigation(employee(memberId))).toMatchObject({ module: false, master: false, joiners: 0, checklists: 0 });

  // Earlier JSON restores can contain values outside the TypeScript model. Preserve the same JS
  // result on these unusual shapes without transferring healthy historical records to Node.
  const legacy = [
    make('LEGACY-ARRAY-DATE', { source: { joinDate: [cutoff] as unknown as string } }),
    make('LEGACY-NULL-TASK-AFTER-OPEN', { tasks: [task, null as unknown as Task] }),
    make('LEGACY-EMPTY-CANCEL', { requisitions: [req('', null)] }),
    make('LEGACY-NULL-SOURCE', { source: { joinDate: null as unknown as string }, local: { joinDate: cutoff } }),
  ];
  expect(legacy.map(row => visibleRecentJoiner(config, row.data, today))).toEqual([true, true, true, false]);
  await owner.db.insert(lcOnboardingCase).values(legacy);
  expect((await onboardingNavigation(admin)).joiners).toBe(expected + 3);

  const evidence = {
    kind: 'NATIVE_SHARED_ONBOARDING_SHELL_COUNT_COMPONENT_ONLY', releaseEligible: false, retainedRows: originalRows.length,
    literalExpectedJoiners: expected, applicationRoundTrips: aggregateRoundTrips,
    nativeAggregateCaseReads: caseReads.length, baselineFullCaseDtoBytes: Buffer.byteLength(JSON.stringify(originalRows)),
    standardCaseDtoHydrationRemoved: true, legacyFallbackExact: true, independentBoundaryControls: explicit.length,
    shellDtoBytes: Buffer.byteLength(JSON.stringify(reference)), baselineReadAndCanonicalFilterMs: originalReadMs,
    completeAggregateNavigationMs: elapsedMs, scopeAndRevocationProven: true,
    providerCalls: 0, limitations: 'Native component on fictional retained data; no browser latency or 500-user claim.',
  };
  if (process.env.AIHR_FOCUSED_EVIDENCE_DIR) writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR, 'onboarding-navigation-count-profile.json'), JSON.stringify(evidence, null, 2));
}, 300000);
