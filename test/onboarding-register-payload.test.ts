/** Native New Joiners payload: exact existing privacy/display order and all-history latest sync. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { saveEmployeeDraft } from '../core/employee-draft';
import { client, type SessionContext } from '../db/client';
import { lcOnboardingCase, lcOnboardingSeen } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { dayDate, visibleRecentJoiner, type Case, type Task } from '../lib/onboarding-model';
import { onboardingList, onboardingMarkSeen, onboardingRegisterContext, onboardingRegisterRows, onboardingSaveConfig, onboardingSetup } from '../packs/lifecycle/service';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);
afterEach(() => vi.restoreAllMocks());

it('serializes the same visible projected joiners without retired cases or unneeded progress DTOs', async () => {
  await resetDb();
  const b = await seedBase();
  await setModule(b.tenantId, 'lifecycle', 'active');
  const admin = await entitledCtx(b), today = todayInKualaLumpur();
  await onboardingSetup(admin);
  const start = await onboardingRegisterContext(admin);
  const memberId = await createAppUser(b.tenantId, null, 'employee');
  const member: SessionContext = { ...await entitledCtx(b, ['employee']), userId: memberId, personId: null, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  const config = structuredClone(start.config);
  config.recentActiveDays = 14;
  config.groups.push({ id: 'register-view', name: 'Fictional register viewers', members: [memberId], limit: 0 });
  config.access.joinerViewGroups = ['register-view'];
  config.access.joinerSections = { 'register-view': { preset: 'custom', s: { checklist: 'hidden', equip: 'hidden', history: 'hidden' } } };
  await onboardingSaveConfig(admin, start.revision, config);
  const draft = await saveEmployeeDraft(admin, { currentStep: 1, data: {
    profile: { fullName: 'Fictional active register draft', primaryEmail: 'new-joiner@example.test' },
    employment: { companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, hiredOn: today },
  } });
  const [source] = await owner.db.select().from(lcOnboardingCase).where(eq(lcOnboardingCase.sourceDraftId, draft.id));
  await onboardingMarkSeen(admin, source.id);
  const cutoff = dayDate(today, -config.recentActiveDays), prior = dayDate(cutoff, -1);
  const task: Task = {
    id: 'old-open-task', name: 'Fictional retained work', by: 'group', group: 'people-gbs', method: 'rr', opens: null, due: 1, gate: false,
    checklistId: 'retained-checklist', checklistName: 'Fictional checklist', status: 'todo', assignee: null, failure: null,
    assignedAt: null, opensOn: null, dueOn: prior, completedAt: null, completedBy: null,
  };
  const make = (number: string, patch: Partial<Case> = {}) => {
    const id = randomUUID();
    return { id, tenantId: b.tenantId, companyId: b.companyId, data: {
      ...structuredClone(source.data), id, number, sourceDraftId: null, personnelStatus: 'Active' as const, state: 'submitted' as const,
      source: { fullName: number, joinDate: prior }, local: {}, syncedAt: '2024-01-01T00:00:00.000Z', tasks: [], requisitions: [],
      notes: 'Fictional retained history. '.repeat(80), ...patch,
    } };
  };
  const oldTask = make('RETAINED-OPEN-TASK', { tasks: [task] });
  const boundary = make('INCLUSIVE-CUTOFF', { source: { joinDate: cutoff } });
  const draftOld = make('RETAINED-DRAFT', { personnelStatus: 'Draft', state: 'cancelled' });
  const newestSync = '2099-01-01T00:00:00.000Z';
  const hiddenSync = make('RETIRED-LATEST-SYNC', { state: 'cancelled', syncedAt: newestSync });
  const retained = [oldTask, boundary, draftOld, hiddenSync, ...Array.from({ length: 1200 }, (_, i) => make('RETIRED-' + i))];
  for (let offset = 0; offset < retained.length; offset += 150) await owner.db.insert(lcOnboardingCase).values(retained.slice(offset, offset + 150));
  const seenRows = retained.map(row => ({ tenantId: b.tenantId, userId: b.adminUserId, caseId: row.id }));
  for (let offset = 0; offset < seenRows.length; offset += 250) await owner.db.insert(lcOnboardingSeen).values(seenRows.slice(offset, offset + 250));

  const display = { today, recentActiveDays: config.recentActiveDays };
  const fullStart = performance.now(), full = await onboardingList(admin), fullMs = performance.now() - fullStart;
  expect(full).toHaveLength(1205);
  const exactProjection = (rows: typeof full) => rows.filter(row => visibleRecentJoiner(config, row.case, today))
    .map(row => ({ case: row.case, isNew: row.isNew }));
  const nativeBegin = client.begin.bind(client), seenStatements: string[] = [];
  const spy = vi.spyOn(client, 'begin').mockImplementation(((...args: unknown[]) => {
    const index = args.findIndex(arg => typeof arg === 'function'), callback = args[index] as (native: typeof client) => unknown;
    args[index] = (native: typeof client) => callback(new Proxy(native, { get(target, key, receiver) {
      if (key === 'unsafe') return (...query: unknown[]) => {
        if (typeof query[0] === 'string' && query[0].toLowerCase().includes('from "lc_onboarding_seen"')) seenStatements.push(query[0].toLowerCase());
        return Reflect.apply(target.unsafe, target, query);
      };
      return Reflect.get(target, key, receiver);
    } }));
    return Reflect.apply(nativeBegin, client, args);
  }) as typeof client.begin);
  const compactStart = performance.now(), compact = await onboardingRegisterRows(admin, display), compactMs = performance.now() - compactStart;
  spy.mockRestore();
  expect(compact).toEqual({ rows: exactProjection(full), today, latestSync: newestSync });
  expect(new Set(compact.rows.map(row => row.case.id))).toEqual(new Set([source.id, oldTask.id, boundary.id, draftOld.id]));
  expect(compact.rows.every(row => !row.isNew)).toBe(true);
  expect(JSON.stringify(compact)).not.toContain('RETIRED-LATEST-SYNC');
  expect(seenStatements).toHaveLength(1);
  expect(seenStatements[0]).toContain('= any(');

  const restrictedFull = await onboardingList(member), restricted = await onboardingRegisterRows(member, display);
  expect(restricted).toEqual({ rows: exactProjection(restrictedFull), today, latestSync: newestSync });
  expect(restrictedFull.find(row => row.case.id === oldTask.id)?.case.tasks).toEqual([]);
  expect(new Set(restricted.rows.map(row => row.case.id))).toEqual(new Set([source.id, boundary.id, draftOld.id]));
  expect(restricted.rows.every(row => row.isNew)).toBe(true);
  const foreign = await seedBase();
  await setModule(foreign.tenantId, 'lifecycle', 'active');
  const foreignAdmin = await entitledCtx(foreign);
  await onboardingSetup(foreignAdmin);
  expect(await onboardingRegisterRows(foreignAdmin, display)).toEqual({ rows: [], today, latestSync: '' });
  const fresh = await onboardingRegisterContext(admin);
  fresh.config.groups.find(group => group.id === 'register-view')!.members = [];
  await onboardingSaveConfig(admin, fresh.revision, fresh.config);
  await expect(onboardingRegisterRows(member, display)).rejects.toMatchObject({ code: 'forbidden' });

  if (process.env.AIHR_FOCUSED_EVIDENCE_DIR) writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR, 'onboarding-register-payload.json'), JSON.stringify({
    kind: 'NATIVE_ONBOARDING_REGISTER_CLIENT_PAYLOAD_COMPONENT_ONLY', releaseEligible: false,
    authorizedRows: full.length, adminRows: compact.rows.length, restrictedRows: restricted.rows.length,
    baselineClientPropBytes: Buffer.byteLength(JSON.stringify(full)), compactClientPropBytes: Buffer.byteLength(JSON.stringify(compact)),
    fullMs, compactMs, exactOrderPrivacyLatestSyncAndSeen: true, providerCalls: 0,
    limitations: 'Authorized case JSON still read in PostgreSQL; exact projected client data only. No browser or 500-user claim.',
  }, null, 2));
}, 300000);
