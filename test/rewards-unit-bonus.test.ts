import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch } from '../packs/payroll/service';
import { createRewardUnit, getRewardUnit, saveRewardEntry, saveRewardPolicy, setRewardMember, decideRewardUnit, postRewardUnit } from '../packs/rewards/service';
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
});
