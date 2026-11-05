/** The New Joiners register needs live setup gates and scoped labels, without the work environment. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { saveEmployeeDraft } from '../core/employee-draft';
import { ModuleNotEnabledError } from '../core/entitlements';
import { setLabelGlobal } from '../core/system-labels';
import { client, type SessionContext } from '../db/client';
import { businessUnit, lcOnboardingCase, position } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  onboardingContext, onboardingOptions, onboardingRegisterContext, onboardingRegisterOptions, onboardingSaveConfig, onboardingSetup,
} from '../packs/lifecycle/service';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);
afterEach(() => vi.restoreAllMocks());

it('keeps register setup/label authority exact without loading case history or the assignment environment', async () => {
  await resetDb();
  const b = await seedBase();
  await setModule(b.tenantId, 'lifecycle', 'active');
  const admin = await entitledCtx(b);
  const empty = await onboardingRegisterContext(admin);
  expect(empty).toMatchObject({ revision: 0, actor: { master: true, module: false } });
  await onboardingSetup(admin);
  const startContext = await onboardingRegisterContext(admin);
  const userId = await createAppUser(b.tenantId, null, 'employee');
  const member: SessionContext = { ...await entitledCtx(b, ['employee']), userId, personId: null, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  const config = structuredClone(startContext.config);
  config.access.onboarding.push(userId);
  await onboardingSaveConfig(admin, startContext.revision, config);
  const [buA, buB] = await owner.db.insert(businessUnit).values([
    { tenantId: b.tenantId, companyId: b.companyId, code: 'BU-A', name: 'Group A', label: 'Fictional shared group' },
    { tenantId: b.tenantId, companyId: b.companyId, code: 'BU-B', name: 'Group B', label: 'Fictional shared group' },
  ]).returning();
  const [title] = await owner.db.insert(position).values({ tenantId: b.tenantId, companyId: b.companyId, title: 'Fictional title', description: 'Fictional description fallback' }).returning();
  await setLabelGlobal(admin, { kind: 'business_unit', labelId: buA.id, isGlobal: true });
  await setLabelGlobal(admin, { kind: 'business_unit', labelId: buB.id, isGlobal: true });
  await setLabelGlobal(admin, { kind: 'position', labelId: title.id, isGlobal: true });
  const draft = await saveEmployeeDraft(admin, { currentStep: 1, data: {
    profile: { fullName: 'Fictional register draft', primaryEmail: 'register@example.test' },
    employment: { companyId: b.companyId, departmentId: b.deptA, positionId: title.id, hiredOn: todayInKualaLumpur() },
  } });
  const [source] = await owner.db.select().from(lcOnboardingCase).where(eq(lcOnboardingCase.sourceDraftId, draft.id));
  expect(source.data.personnelStatus).toBe('Draft');
  const retained = Array.from({ length: 512 }, (_, i) => {
    const id = randomUUID();
    return { id, tenantId: b.tenantId, companyId: b.companyId, data: {
      ...structuredClone(source.data), id, number: 'REGISTER-RETAINED-' + i, sourceDraftId: null,
      state: 'cancelled' as const, notes: 'Fictional retained register detail. '.repeat(80),
    } };
  });
  for (let offset = 0; offset < retained.length; offset += 150) await owner.db.insert(lcOnboardingCase).values(retained.slice(offset, offset + 150));

  const nativeBegin = client.begin.bind(client), reads: string[] = [];
  vi.spyOn(client, 'begin').mockImplementation(((...args: unknown[]) => {
    const index = args.findIndex(arg => typeof arg === 'function'), callback = args[index] as (native: typeof client) => unknown;
    args[index] = (native: typeof client) => callback(new Proxy(native, { get(target, key, receiver) {
      if (key === 'unsafe') return (...query: unknown[]) => {
        if (typeof query[0] === 'string') reads.push(query[0].toLowerCase());
        return Reflect.apply(target.unsafe, target, query);
      };
      return Reflect.get(target, key, receiver);
    } }));
    return Reflect.apply(nativeBegin, client, args);
  }) as typeof client.begin);
  const fullStart = performance.now();
  const full = await onboardingContext(admin), fullOptions = await onboardingOptions(admin);
  const fullMs = performance.now() - fullStart, fullReads = reads.splice(0);
  const compactStart = performance.now();
  const compact = await onboardingRegisterContext(admin), options = await onboardingRegisterOptions(admin);
  const compactMs = performance.now() - compactStart, compactReads = reads.splice(0);
  const pick = (value: typeof full) => ({ config: value.config, revision: value.revision, actor: value.actor });
  const pickOptions = (value: typeof fullOptions) => ({ businessGroup: value.businessGroup, title: value.title });
  expect(compact).toEqual(pick(full));
  expect(options).toEqual(pickOptions(fullOptions));
  expect(options.businessGroup).toEqual([
    { id: buA.id, name: 'Fictional shared group (Group A)' }, { id: buB.id, name: 'Fictional shared group (Group B)' },
  ]);
  expect(options.title).toContainEqual({ id: title.id, name: 'Fictional description fallback' });
  expect(full.totalJoiners).toBe(1);
  const omittedSources = ['from "lc_onboarding_case"', 'app.onboarding_directory(', 'app.onboarding_assignment_loads(', 'app.onboarding_unavailable(', 'app.onboarding_supervisors('];
  expect(omittedSources.every(source => fullReads.some(query => query.includes(source)))).toBe(true);
  expect(compactReads.some(query => omittedSources.some(source => query.includes(source)))).toBe(false);
  expect(compactReads.length).toBeLessThan(fullReads.length);
  expect(await onboardingRegisterContext(member)).toEqual(pick(await onboardingContext(member)));
  expect(await onboardingRegisterOptions(member)).toEqual(pickOptions(await onboardingOptions(member)));

  const foreign = await seedBase();
  await setModule(foreign.tenantId, 'lifecycle', 'active');
  const foreignAdmin = await entitledCtx(foreign);
  const foreignOptions = await onboardingRegisterOptions(foreignAdmin);
  expect(foreignOptions.businessGroup).toEqual([]);
  expect(foreignOptions.title.some(row => row.id === title.id)).toBe(false);
  const fresh = await onboardingRegisterContext(admin);
  fresh.config.access.onboarding = fresh.config.access.onboarding.filter(id => id !== userId);
  await onboardingSaveConfig(admin, fresh.revision, fresh.config);
  expect((await onboardingRegisterContext(member)).actor.module).toBe(false);
  await expect(onboardingRegisterOptions(member)).rejects.toMatchObject({ code: 'forbidden' });
  await setModule(b.tenantId, 'lifecycle', 'disabled');
  await expect(onboardingRegisterContext(await entitledCtx(b))).rejects.toBeInstanceOf(ModuleNotEnabledError);

  if (process.env.AIHR_FOCUSED_EVIDENCE_DIR) writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR, 'onboarding-register-context.json'), JSON.stringify({
    kind: 'NATIVE_ONBOARDING_REGISTER_CONTEXT_COMPONENT_ONLY', releaseEligible: false,
    retainedCaseRows: retained.length + 1, exactSetupAndScopedLabels: true,
    baselineRoundTrips: fullReads.length, compactRoundTrips: compactReads.length,
    baselineBytes: Buffer.byteLength(JSON.stringify([full, fullOptions])), compactBytes: Buffer.byteLength(JSON.stringify([compact, options])),
    baselineMs: fullMs, compactMs, providerCalls: 0,
    limitations: 'Context and options only; the separate register row reader is unchanged. No browser or 500-user claim.',
  }, null, 2));
}, 300000);
