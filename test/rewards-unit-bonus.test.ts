import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch } from '../packs/payroll/service';
import { createRewardUnit, getRewardUnit, saveRewardEntry, saveRewardPolicy, setRewardMember, setRewardUnitLump, decideRewardUnit, postRewardUnit, previewRewardMultiplier, saveRewardMultiplier } from '../packs/rewards/service';
import { emptyFacts, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

// A corrupted calculation cannot be produced from valid inputs (every component is >= 0), so the
// forged fixture lowers a calculated new basic salary and lets the engine's own SAL-01 guard judge it.
const forge = vi.hoisted(() => ({ on: false }));
vi.mock('../packs/rewards/engine', async importOriginal => {
  const actual = await importOriginal<typeof import('../packs/rewards/engine')>();
  return { ...actual, calculateRewards: (...args: Parameters<typeof actual.calculateRewards>) => {
    const result = actual.calculateRewards(...args);
    if (!forge.on) return result;
    result.rows[0].newBasicCents = result.rows[0].source.basicCents - 10000;
    result.flags.push(...actual.salaryReductionFlags(result.rows));
    return result;
  } };
});

const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
describe('Rewards unit bonus inputs (fictional fixtures)', () => {
  let b: Base, admin: SessionContext, unitId: string, employmentId: string, buId: string;
  const actors: Partial<Record<RewardRole, SessionContext>> = {};
  const view = () => getRewardUnit(admin, unitId);
  beforeEach(async () => {
    forge.on = false;
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Rewards administrator', primaryEmail: 'administrator@rewards.test' }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: adminPerson.id };
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'NS', name: 'Northern Sales' }).returning();
    buId = bu.id;
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    const hire = await hireEmployee(admin, { person: { fullName: 'Reward Employee', primaryEmail: 'employee@rewards.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    employmentId = hire.employmentId;
    await owner.db.update(schema.assignment).set({ businessUnitId: bu.id }).where(eq(schema.assignment.employmentId, employmentId));
    await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, employmentId));
    await setCompensation(admin, { employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    unitId = await createRewardUnit(admin, { name: 'Annual rewards', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    for (const role of ['bu', 'bg', 'ctro', 'ec', 'pbp'] as const) {
      const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `${role} reviewer`, primaryEmail: `${role}@rewards.test` }).returning();
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      actors[role] = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
      await setRewardMember(admin, unitId, (await view()).unit.revision, userId, role);
    }
    actors.gr = admin;
    await setRewardMember(admin, unitId, (await view()).unit.revision, admin.userId!, 'payroll');
    const v = await view();
    await saveRewardPolicy(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view();
    await saveRewardEntry(admin, unitId, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
  });
  afterAll(closeAll);
  async function approve() {
    const rev = (await view()).unit.revision;
    await decideRewardUnit(actors.bu!, unitId, rev, 'submit', 'Reviewed recommendations');
    for (const role of ['bg', 'gr', 'ctro', 'ec'] as const) await decideRewardUnit(actors[role]!, unitId, rev, 'approve', 'Reviewed recommendations');
    return rev;
  }

  describe('328ebe84 no salary reduction', () => {
    it('refuses a negative merit, promotion or special adjustment before writing', async () => {
      const v = await view(), row = v.rows[0];
      for (const key of ['meritBp', 'promotionBp', 'specialBp'] as const)
        await expect(saveRewardEntry(admin, unitId, v.unit.revision, row.id, { ...row.recommendation, [key]: -200 })).rejects.toThrow(/too small|>=0/i);
      expect((await view()).unit.revision).toBe(v.unit.revision);
    });
    it('a forged reduction raises SAL-01 and refuses submission and posting without writing pay', async () => {
      expect((await view()).flags.some(f => f.code === 'SAL-01')).toBe(false);
      forge.on = true;
      const forged = await view();
      expect(forged.flags).toContainEqual(expect.objectContaining({ code: 'SAL-01', severity: 'block', entryId: forged.rows[0].id }));
      await expect(decideRewardUnit(actors.bu!, unitId, forged.unit.revision, 'submit', 'Reviewed recommendations')).rejects.toThrow(/blocking checks/);
      forge.on = false;
      const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
      forge.on = true;
      await expect(postRewardUnit(admin, unitId, rev, batch.batchId)).rejects.toThrow(/no longer passes validation/);
      const [comp] = await owner.db.select().from(schema.compensation).where(and(eq(schema.compensation.employmentId, employmentId), isNull(schema.compensation.validTo)));
      expect(Number(comp.basicSalary)).toBe(5000);
      expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batch.batchId))).toEqual([]);
      expect((await view()).unit.status).toBe('approved');
    });
  });

  describe('9070acae one review is one company and one unit', () => {
    it('names the company and business unit of the review', async () => {
      const [co] = await owner.db.select().from(schema.company).where(eq(schema.company.id, b.companyId));
      const v = await view();
      expect(v.companyName).toBe(co.legalName);
      expect(v.companyName.length).toBeGreaterThan(0);
      expect(v.name).toBe('NS');
    });
    it('saving a multiplier and a lump sum changes only that review, never another unit of the same scope', async () => {
      const [other] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'SS', name: 'Southern Sales' }).returning();
      const otherId = await createRewardUnit(admin, { name: 'Annual rewards', year, companyId: b.companyId, businessUnitId: other.id, snapshotDate: today });
      const [beforeOther] = await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id, otherId));
      const v = await view();
      const preview = await previewRewardMultiplier(admin, unitId, v.unit.revision, 12000);
      await saveRewardMultiplier(admin, unitId, v.unit.revision, 12000, 'Fictional unit-only override', preview.digest);
      await setRewardUnitLump(admin, unitId, v.unit.revision + 1, { mode: 'set', cents: 50000 });
      const after = await view();
      expect(after.unit.policy.multiplierBp).toBe(12000);
      expect(after.unit.policy.lumpUnitCents).toBe(50000);
      const [afterOther] = await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id, otherId));
      expect(afterOther.policy).toEqual(beforeOther.policy);
      expect(afterOther.revision).toBe(beforeOther.revision);
      expect(afterOther.businessUnitId).toBe(other.id);
      expect(buId).not.toBe(other.id);
    });
  });

  describe('bcd7cc0f unit multiplier basis, impact and reason', () => {
    // Fixture: one grade-12 ME employee, RM 5,000 basic, PAT 100/100, 2.00 target months, ME = 1.5 bonus months.
    // Standard pool = 5,000 x 1.00 x 2.00 = RM 10,000; cost at 1.00 = RM 7,500; affordable 1.3333 -> 1.33.
    it('explains the suggestion from its inputs and shows only rates', async () => {
      const v = await view();
      expect(v.suggestion).toEqual({ patActualMissing: false, achievementBp: 10000, targetMonthsBp: 20000, poolMultiplierBp: 20000, affordableBp: { standard: 13333, h: null } });
      expect(v.suggestedMultiplierBp).toBe(13300);
    });
    it('says Actual PAT is missing when it is zero, which is why the suggestion is 0.00', async () => {
      const v = await view();
      await saveRewardPolicy(admin, unitId, v.unit.revision, { ...v.unit.policy, patActual: 0 });
      const after = await view();
      expect(after.suggestion).toMatchObject({ patActualMissing: true, achievementBp: 0, poolMultiplierBp: 0 });
      expect(after.suggestedMultiplierBp).toBe(0);
    });
    it('previews pool use per plan, refuses above 100% without an exemption and records before, after and reason', async () => {
      const v = await view();
      const within = await previewRewardMultiplier(admin, unitId, v.unit.revision, 12000);
      expect(within).toMatchObject({ beforeBp: null, requestedBp: 12000, effectiveBp: 12000, exempt: false, blocked: false });
      expect(within.plans).toEqual([{ plan: 'standard', nowBp: 9975, afterBp: 9000, over: false }, { plan: 'h', nowBp: null, afterBp: null, over: false }]);
      expect(JSON.stringify(within)).not.toMatch(/Cents|basic/);
      const over = await previewRewardMultiplier(admin, unitId, v.unit.revision, 20000);
      expect(over).toMatchObject({ blocked: true, plans: [{ plan: 'standard', afterBp: 15000, over: true }, { plan: 'h', over: false }] });
      await expect(saveRewardMultiplier(admin, unitId, v.unit.revision, 20000, 'Fictional stretch award', over.digest)).rejects.toThrow(/exceed 100%/);
      await expect(saveRewardMultiplier(admin, unitId, v.unit.revision, 12000, 'too short', within.digest)).rejects.toThrow(/10 characters/);
      await expect(saveRewardMultiplier(admin, unitId, v.unit.revision, 11000, 'Fictional unit-only override', within.digest)).rejects.toThrow(/Check the impact again/);
      expect((await view()).unit.revision).toBe(v.unit.revision);
      await saveRewardMultiplier(admin, unitId, v.unit.revision, 12000, '  Fictional unit-only override  ', within.digest);
      const saved = await view();
      expect(saved.unit.policy.multiplierBp).toBe(12000);
      // The policy owner keeps the reasoned value: a full policy save cannot silently change or clear it.
      await saveRewardPolicy(admin, unitId, saved.unit.revision, { ...saved.unit.policy, multiplierBp: null, exemptReason: 'Fictional acquisition integration' });
      const exempt = await view();
      expect(exempt.unit.policy.multiplierBp).toBe(12000);
      const allowed = await previewRewardMultiplier(admin, unitId, exempt.unit.revision, 20000);
      expect(allowed).toMatchObject({ beforeBp: 12000, exempt: true, blocked: false, plans: [{ over: true }, { over: false }] });
      await saveRewardMultiplier(admin, unitId, exempt.unit.revision, 20000, 'Fictional approved budget exemption', allowed.digest);
      expect((await view()).unit.policy.multiplierBp).toBe(20000);
      const events = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, unitId), eq(schema.domainEvent.eventType, 'reward-unit.multiplier-updated'))).orderBy(asc(schema.domainEvent.sequence));
      expect(events.map(e => e.payload)).toEqual([
        { revision: v.unit.revision + 1, before: null, after: 12000, reason: 'Fictional unit-only override' },
        { revision: exempt.unit.revision + 1, before: 12000, after: 20000, reason: 'Fictional approved budget exemption' },
      ]);
      expect(events.map(e => [e.actorType, e.actorId])).toEqual([['user', admin.userId], ['user', admin.userId]]);
    });
    it('refuses non-Group Rewards reviewers, a submitted review and a branch-factor review', async () => {
      const v = await view();
      await expect(previewRewardMultiplier(actors.bu!, unitId, v.unit.revision, 12000)).rejects.toThrow(/Only Group Rewards/);
      const preview = await previewRewardMultiplier(admin, unitId, v.unit.revision, 12000);
      await expect(saveRewardMultiplier(actors.bg!, unitId, v.unit.revision, 12000, 'Fictional unit-only override', preview.digest)).rejects.toThrow(/Only Group Rewards/);
      await saveRewardPolicy(admin, unitId, v.unit.revision, { ...v.unit.policy, bonusStructure: 'branch' });
      await expect(previewRewardMultiplier(admin, unitId, v.unit.revision + 1, 12000)).rejects.toThrow(/branch factors/);
      const branch = await view();
      await saveRewardPolicy(admin, unitId, branch.unit.revision, { ...branch.unit.policy, bonusStructure: 'standard' });
      const rev = (await view()).unit.revision;
      await decideRewardUnit(actors.bu!, unitId, rev, 'submit', 'Reviewed recommendations');
      await expect(previewRewardMultiplier(admin, unitId, rev, 12000)).rejects.toThrow(/Return the unit to draft/);
      expect(await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, unitId), eq(schema.domainEvent.eventType, 'reward-unit.multiplier-updated')))).toEqual([]);
    });
  });
});
