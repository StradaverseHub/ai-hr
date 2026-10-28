import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createRewardUnit, getRewardUnit, previewRewardLump, saveRewardEntry, saveRewardPolicy, setRewardMember, setRewardPayWindowKeep, setRewardUnitLump } from '../packs/rewards/service';
import { emptyFacts } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

// 8ad87ae8 pay-change exclusion, 4e3e1af7 lump-sum choice and c28db2f0 lump-sum preview — fictional fixtures.
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const inWindow = (md: string) => `${year}-${md}`;
describe('Rewards board items 8ad87ae8, 4e3e1af7, c28db2f0', () => {
  let b: Base, admin: SessionContext, bu: SessionContext, unitId: string, employmentId: string;
  const view = () => getRewardUnit(admin, unitId);
  const lastEvent = async (eventType: string) => (await owner.db.select().from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.aggregateId, unitId), eq(schema.domainEvent.eventType, eventType))).orderBy(desc(schema.domainEvent.sequence)).limit(1))[0];
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Rewards administrator', primaryEmail: 'administrator@rewards.test' }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: adminPerson.id };
    const [unit] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'NS', name: 'Northern Sales' }).returning();
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    const hire = await hireEmployee(admin, { person: { fullName: 'Reward Employee', primaryEmail: 'employee@rewards.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    employmentId = hire.employmentId;
    await owner.db.update(schema.assignment).set({ businessUnitId: unit.id }).where(eq(schema.assignment.employmentId, employmentId));
    await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, employmentId));
    await setCompensation(admin, { employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    // In the window: a tagged promotion, a re-save with the same basic (not a change), and a future-dated raise.
    await setCompensation(admin, { employmentId, basicSalary: 5500, effectiveFrom: inWindow('10-01'), movement: { type: 'promotion' } });
    await setCompensation(admin, { employmentId, basicSalary: 5500, effectiveFrom: inWindow('10-15') });
    await setCompensation(admin, { employmentId, basicSalary: 6000, effectiveFrom: inWindow('12-01') });
    unitId = await createRewardUnit(admin, { name: 'Annual rewards', year, companyId: b.companyId, businessUnitId: unit.id, snapshotDate: today });
    const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'BU reviewer', primaryEmail: 'bu@rewards.test' }).returning();
    const userId = await createAppUser(b.tenantId, p.id, 'employee');
    bu = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
    await setRewardMember(admin, unitId, (await view()).unit.revision, userId, 'bu');
    const v = await view();
    await saveRewardPolicy(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view();
    await saveRewardEntry(admin, unitId, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
  });
  afterAll(closeAll);

  describe('8ad87ae8 pay-change exclusion', () => {
    it('reads every basic change in the window, including after the snapshot, and skips a same-basic re-save', async () => {
      const row = (await view()).rows[0];
      expect(row.source.payChanges).toEqual([{ on: inWindow('10-01'), basicCents: 550000, kind: 'promotion' }, { on: inWindow('12-01'), basicCents: 600000, kind: null }]);
      expect(row.incrementReason).toBe('Pay change in the exclusion window');
      expect(row.newBasicCents).toBe(row.source.basicCents);
      expect(row.payChange).toEqual({ on: inWindow('12-01'), kind: null });
      expect(row.bonusBasicCents).toBe(600000);
      const v = await view();
      expect(v.payWindow.standard).toEqual({ count: 1, payrollCents: row.source.basicCents });
      expect(v.budgets.standard.payrollCents).toBe(0);
      expect(v.budgets.standard.bonusPayrollCents).toBe(600000);
    });

    it('only Group Rewards keeps a person eligible, with a reason, and the decision is recorded and survives a policy save', async () => {
      const v = await view(), entryId = v.rows[0].id;
      await expect(setRewardPayWindowKeep(bu, unitId, v.unit.revision, entryId, true, 'Payroll correction entered twice')).rejects.toThrow(/Group Rewards/);
      await expect(setRewardPayWindowKeep(admin, unitId, v.unit.revision, entryId, true, 'short')).rejects.toThrow(/10 characters/);
      await setRewardPayWindowKeep(admin, unitId, v.unit.revision, entryId, true, 'Payroll correction entered twice');
      const kept = await view();
      expect(kept.rows[0].incrementEligible).toBe(true);
      expect(kept.rows[0].payWindowKept).toBe(true);
      expect(kept.payWindow.standard).toEqual({ count: 0, payrollCents: 0 });
      expect((await lastEvent('reward-unit.pay-window-updated'))?.payload).toMatchObject({ entryId, before: false, after: true, reason: 'Payroll correction entered twice' });
      await saveRewardPolicy(admin, unitId, kept.unit.revision, { ...kept.unit.policy, patActual: 110 });
      expect((await view()).unit.policy.payWindowKeep).toEqual({ [employmentId]: 'Payroll correction entered twice' });
      const again = await view();
      await setRewardPayWindowKeep(admin, unitId, again.unit.revision, entryId, false, 'Correction confirmed as a real raise');
      expect((await view()).rows[0].incrementReason).toBe('Pay change in the exclusion window');
      expect((await view()).unit.policy.payWindowKeep).toBeUndefined();
    });
  });

  describe('4e3e1af7 lump-sum choice', () => {
    it('withholding needs a reason; every change records old and new amount, choice and reason', async () => {
      const v = await view();
      await expect(setRewardUnitLump(bu, unitId, v.unit.revision, { mode: 'withhold', reason: 'short' })).rejects.toThrow(/10 characters/);
      await expect(setRewardUnitLump(bu, unitId, v.unit.revision, { mode: 'set', cents: 0 })).rejects.toThrow();
      await setRewardUnitLump(bu, unitId, v.unit.revision, { mode: 'withhold', reason: 'BU missed the PAT floor' });
      const withheld = await view();
      expect(withheld.unit.policy.lumpUnitCents).toBe(0);
      expect(withheld.unit.policy.lumpReason).toBe('BU missed the PAT floor');
      expect(withheld.lumpDecision).toMatchObject({ reason: 'BU missed the PAT floor', actorName: 'BU reviewer', at: today });
      expect((await lastEvent('reward-unit.lump-updated'))?.payload).toMatchObject({ mode: 'withhold', before: null, after: 0, reason: 'BU missed the PAT floor' });
      await setRewardUnitLump(bu, unitId, withheld.unit.revision, { mode: 'auto' });
      const auto = await view();
      expect(auto.unit.policy.lumpUnitCents).toBeNull();
      expect(auto.unit.policy.lumpReason).toBeUndefined();
      expect(auto.lumpDecision).toBeNull();
      expect((await lastEvent('reward-unit.lump-updated'))?.payload).toMatchObject({ mode: 'auto', before: 0, after: null, reason: null });
    });
  });

  describe('c28db2f0 lump-sum preview', () => {
    it('previews the per-plan effect without writing, and matches the saved result', async () => {
      const before = await view();
      const preview = await previewRewardLump(admin, unitId, before.unit.revision, 30000);
      const after = await view();
      expect(after.unit.revision).toBe(before.unit.revision);
      expect(after.unit.policy.lumpUnitCents).toBe(before.unit.policy.lumpUnitCents);
      expect(preview.lumpUnitCents).toBe(30000);
      expect(preview.plans.map(p => p.plan)).toEqual(['standard', 'h']);
      await setRewardUnitLump(admin, unitId, before.unit.revision, { mode: 'set', cents: 30000 });
      const saved = await view();
      const standard = preview.plans[0];
      expect(standard.lumpCents).toBe(saved.budgets.standard.lumpCents);
      expect(standard.balanceCents).toBe(saved.budgets.standard.balanceCents);
      expect(standard.count).toBe(saved.rows.filter(r => r.plan === 'standard' && r.lumpEligible).length);
      expect(standard.amendments).toBe(0);
      await expect(previewRewardLump(admin, unitId, before.unit.revision, 30000)).rejects.toThrow();
    });
  });
});
