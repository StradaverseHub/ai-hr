import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createRewardUnit, emptyRewardCalendar, getRewardUnit, listRewardUnits, saveRewardCalendar, saveRewardEntry, saveRewardPolicy, setRewardMember } from '../packs/rewards/service';
import { emptyFacts, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
describe('Rewards configuration list (7a8102a7)', () => {
  let b: Base, admin: SessionContext, unitId: string;
  const actors: Partial<Record<RewardRole, SessionContext>> = {};
  const view = () => getRewardUnit(admin, unitId);
  const row = async (who = admin) => (await listRewardUnits(who, [b.companyId])).find(r => r.id === unitId)!;
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional Rewards administrator', primaryEmail: 'administrator@rewards-config.test' }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: adminPerson.id };
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'HQ', name: 'Headquarters' }).returning();
    for (const n of [1, 2]) {
      const hire = await hireEmployee(admin, { person: { fullName: `Fictional Reward Employee ${n}`, primaryEmail: `employee${n}@rewards-config.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
      await owner.db.update(schema.assignment).set({ businessUnitId: bu.id }).where(eq(schema.assignment.employmentId, hire.employmentId));
      await setCompensation(admin, { employmentId: hire.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    }
    unitId = await createRewardUnit(admin, { name: 'Fictional Annual Compensation Review', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    for (const role of ['bu', 'bg', 'ctro', 'ec'] as const) {
      const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `Fictional ${role} reviewer`, primaryEmail: `${role}@rewards-config.test` }).returning();
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      actors[role] = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
      await setRewardMember(admin, unitId, (await view()).unit.revision, userId, role);
    }
    actors.gr = admin;
  });
  afterAll(closeAll);

  it('lists counts, the current seat with its holders, the due date and the salary effective date', async () => {
    const v = await view();
    await saveRewardEntry(admin, unitId, v.unit.revision, v.rows[0].id, v.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    const due = addDays(today, 3);
    await saveRewardCalendar(admin, unitId, 0, { ...emptyRewardCalendar(), due: { ...emptyRewardCalendar().due, bu: due } });
    const r = await row();
    expect(r).toMatchObject({ status: 'draft', people: 2, verified: 1, seat: 'bu', holders: ['Fictional bu reviewer'], due, daysUntilDue: 3, effectiveFrom: `${year + 1}-01-01`, year });
    // Counts only: no salary or employee field leaves the list.
    expect(JSON.stringify(r)).not.toMatch(/5000|Fictional Reward Employee/);
  });

  it('withholds counts from a viewer without a seat rather than showing a partial total', async () => {
    const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional seatless administrator', primaryEmail: 'seatless@rewards-config.test' }).returning();
    const userId = await createAppUser(b.tenantId, p.id, 'hr_admin');
    const r = await row({ ...admin, userId, personId: p.id });
    expect(r.people).toBeNull(); expect(r.verified).toBeNull();
    expect(r.seat).toBe('bu');
  });

  it('shows no holder when the seat is empty and no due date when the calendar has none', async () => {
    await setRewardMember(admin, unitId, (await view()).unit.revision, actors.bu!.userId!, 'bu', true);
    const r = await row();
    expect(r.holders).toEqual([]); expect(r.due).toBeNull(); expect(r.daysUntilDue).toBeNull();
  });

  it('adds a review to an existing cycle without a name and keeps the cycle name; a new cycle still needs one', async () => {
    const r = await row();
    const [other] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'BR', name: 'Branch' }).returning();
    const id = await createRewardUnit(admin, { cycleId: r.cycleId, year, companyId: b.companyId, businessUnitId: other.id, snapshotDate: today });
    expect((await listRewardUnits(admin, [b.companyId])).find(x => x.id === id)?.cycle).toBe('Fictional Annual Compensation Review');
    await expect(createRewardUnit(admin, { name: '  ', year, companyId: b.companyId, businessUnitId: other.id, snapshotDate: today })).rejects.toThrow('Name the new review cycle.');
  });

  it('reads the effective date from the review settings', async () => {
    const v = await view();
    await saveRewardPolicy(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: `${year + 1}-03-01` });
    expect((await row()).effectiveFrom).toBe(`${year + 1}-03-01`);
  });
});
