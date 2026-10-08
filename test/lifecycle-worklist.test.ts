/**
 * Lifecycle worklist + export (ADR-0095). The windows are the handover's; the worklist is live, so an item
 * disappears the moment its work is done, and the export masks identity numbers.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  APPROVAL_CHASE_DAYS, EXPIRY_AHEAD, createOffboardingCase, createOnboardingCase, createStandaloneRequisition, exportLifecycleCsv, isExpiryDue,
  isLastWorkingDayDue, isOnboardingStartDue, lifecycleWorklist, registerAsset, saveCompanyConfig, setOutcome, setProvision, tickStep, whenOf,
} from '../packs/lifecycle/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';

const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

describe('worklist windows (pure)', () => {
  const t = '2026-10-08';
  it('last working day: 3 days ahead or already past', () => {
    expect(isLastWorkingDayDue('2026-10-11', t)).toBe(true);
    expect(isLastWorkingDayDue('2026-10-12', t)).toBe(false);
    expect(isLastWorkingDayDue('2026-09-01', t)).toBe(true);
    expect(isLastWorkingDayDue(null, t)).toBe(false);
  });
  it('onboarding start: from 3 days ahead to 7 days ago', () => {
    expect(isOnboardingStartDue('2026-10-11', t)).toBe(true);
    expect(isOnboardingStartDue('2026-10-12', t)).toBe(false);
    expect(isOnboardingStartDue('2026-10-01', t)).toBe(true);
    expect(isOnboardingStartDue('2026-09-30', t)).toBe(false);
  });
  it('warranty / lease: 60 days ahead to 30 days back', () => {
    expect(isExpiryDue(plus(t, EXPIRY_AHEAD), t)).toBe(true);
    expect(isExpiryDue(plus(t, EXPIRY_AHEAD + 1), t)).toBe(false);
    expect(isExpiryDue(plus(t, -30), t)).toBe(true);
    expect(isExpiryDue(plus(t, -31), t)).toBe(false);
  });
  it('words the offset', () => {
    expect(whenOf(0)).toEqual({ key: 'today', n: 0 });
    expect(whenOf(1)).toEqual({ key: 'tomorrow', n: 1 });
    expect(whenOf(5)).toEqual({ key: 'inDays', n: 5 });
    expect(whenOf(-2)).toEqual({ key: 'daysAgo', n: 2 });
  });
});

describe('worklist and export', () => {
  let b: Base; let admin: SessionContext; let agent: SessionContext; let manager: SessionContext; let requester: SessionContext;
  const today = todayInKualaLumpur();
  beforeEach(async () => {
    await resetDb(); b = await seedBase();
    await setModule(b.tenantId, 'lifecycle', 'active');
    admin = await entitledCtx(b);
    const mk = async (n: string) => {
      const h = await hireEmployee(admin, { person: { fullName: n, primaryEmail: `${n.toLowerCase()}@acme.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
      const userId = await createAppUser(b.tenantId, h.personId, 'employee');
      return { userId, ctx: { ...admin, userId, personId: h.personId, roles: ['employee'], grants: undefined } as SessionContext };
    };
    const a = await mk('Agent'); const m = await mk('Manager'); const r = await mk('Req');
    agent = a.ctx; manager = m.ctx; requester = r.ctx;
    await owner.db.insert(schema.lcStaff).values([
      { tenantId: b.tenantId, userId: a.userId, level: 'agent' }, { tenantId: b.tenantId, userId: m.userId, level: 'manager' },
    ]);
  });
  afterAll(async () => { await closeAll(); });

  it('a requester has an empty worklist; staff see their prompts', async () => {
    expect(await lifecycleWorklist(requester)).toEqual([]);
    await createOffboardingCase(agent, { companyId: b.companyId, fullName: 'Leaver', employeeNo: 'E1', resignationDate: today, lastWorkingDay: plus(today, 2) });
    expect(await lifecycleWorklist(agent)).toEqual([]); // outcome still pending: nothing to chase yet
  });

  it('last-working-day prompt appears for an accepted case and stops when the return and access steps are done', async () => {
    const { number } = await createOffboardingCase(agent, { companyId: b.companyId, fullName: 'Leaver', employeeNo: 'E1', resignationDate: today, lastWorkingDay: plus(today, 2) });
    await setOutcome(agent, number, 'accepted');
    let w = await lifecycleWorklist(agent);
    expect(w.filter((x) => x.kind === 'lastWorkingDay')).toEqual([expect.objectContaining({ ref: number, detail: '2', days: 2 })]);
    await tickStep(agent, 'offboarding', number, 'it_asset_return');
    w = await lifecycleWorklist(agent);
    expect(w.find((x) => x.kind === 'lastWorkingDay')!.detail).toBe('1');
    await tickStep(agent, 'offboarding', number, 'sys_access_revoke');
    expect((await lifecycleWorklist(agent)).filter((x) => x.kind === 'lastWorkingDay')).toEqual([]);
  });

  it('onboarding-start prompt shows the open requisition progress and clears when it completes', async () => {
    await saveCompanyConfig(admin, b.companyId, { approvalLevels: 0, accessSystems: [] });
    const { number, requisitionNumber } = await createOnboardingCase(agent, { companyId: b.companyId, fullName: 'Hire', employeeNo: 'E2', joinDate: plus(today, 1) });
    const w = (await lifecycleWorklist(agent)).find((x) => x.kind === 'onboardingStart')!;
    expect(w.ref).toBe(number);
    expect(w.detail.startsWith(requisitionNumber)).toBe(true);
    const { getRequisition } = await import('../packs/lifecycle/service');
    for (const it of (await getRequisition(agent, requisitionNumber)).items) await setProvision(agent, requisitionNumber, it.itemKey, 'done');
    expect((await lifecycleWorklist(agent)).filter((x) => x.kind === 'onboardingStart')).toEqual([]);
  });

  it('chases approvals only after the threshold, and only for managers', async () => {
    await saveCompanyConfig(admin, b.companyId, { approvalLevels: 1, accessSystems: [] });
    const r = await createStandaloneRequisition(agent, { companyId: b.companyId, fullName: 'X', employeeNo: 'E3' });
    expect((await lifecycleWorklist(manager)).filter((x) => x.kind === 'approval')).toEqual([]);
    await owner.db.update(schema.itRequisition).set({ createdAt: new Date(Date.now() - APPROVAL_CHASE_DAYS * 86400000 - 3600000) }).where(eq(schema.itRequisition.number, r.number));
    expect((await lifecycleWorklist(manager)).filter((x) => x.kind === 'approval').map((x) => x.ref)).toEqual([r.number]);
    expect((await lifecycleWorklist(agent)).filter((x) => x.kind === 'approval')).toEqual([]); // agents do not approve
  });

  it('flags warranty and lease dates inside the window', async () => {
    const a = await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop', warrantyEnd: plus(today, 20), leased: true, leaseEnd: plus(today, 400) });
    await registerAsset(agent, { companyId: b.companyId, assetType: 'laptop', warrantyEnd: plus(today, 400) });
    const w = (await lifecycleWorklist(agent)).filter((x) => x.kind === 'expiry');
    expect(w.map((x) => [x.ref, x.detail])).toEqual([[a.code, 'warranty']]);
  });

  it('exports are manager-only and mask identity numbers; cost centre and notes never leave', async () => {
    await createOnboardingCase(agent, { companyId: b.companyId, fullName: 'Ann', employeeNo: 'E9', joinDate: plus(today, 5), nricPassport: '900101-14-5678', costCentre: 'CC-SECRET', notes: 'private note' });
    await expect(exportLifecycleCsv(agent, 'onboarding')).rejects.toThrow(/Not permitted/);
    await expect(exportLifecycleCsv(requester, 'assets')).rejects.toThrow(/Not permitted/);
    const csv = await exportLifecycleCsv(manager, 'onboarding');
    expect(csv).toContain('5678');
    expect(csv).not.toContain('900101-14-5678');
    expect(csv).not.toContain('CC-SECRET');
    expect(csv).not.toContain('private note');
    expect((await exportLifecycleCsv(manager, 'onboarding', { from: plus(today, 1) })).split('\r\n').filter(Boolean)).toHaveLength(1); // header only
  });
});
