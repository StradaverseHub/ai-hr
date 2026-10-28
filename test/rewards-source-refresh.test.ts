import {setRewardMember} from './rewards-access-fixture';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createRewardUnit, getRewardUnit, previewRewardSourceRefresh, saveRewardEntry, saveRewardSourceRefresh } from '../packs/rewards/service';
import { emptyFacts } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

/** 40bf44f7 — refresh is a preview → confirm over the HR date owner's "today"; leavers are kept and marked. */
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const earlier = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
describe('Rewards source refresh preview and confirm', () => {
  let b: Base, admin: SessionContext, bu: SessionContext, unitId: string, buId: string, gradeId: string;
  const ids: Record<string, string> = {};
  const view = () => getRewardUnit(admin, unitId);
  async function hire(key: string, confirmed = true) {
    const h = await hireEmployee(admin, { person: { fullName: `Refresh ${key}`, primaryEmail: `${key}@refresh.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    await owner.db.update(schema.assignment).set({ businessUnitId: buId }).where(eq(schema.assignment.employmentId, h.employmentId));
    await owner.db.update(schema.employment).set({ gradeId, confirmationDate: confirmed ? `${year - 2}-04-01` : null }).where(eq(schema.employment.id, h.employmentId));
    await setCompensation(admin, { employmentId: h.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    ids[key] = h.employmentId;
  }
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Refresh administrator', primaryEmail: 'administrator@refresh.test' }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: adminPerson.id };
    const [unit] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'RF', name: 'Refresh unit' }).returning(); buId = unit.id;
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning(); gradeId = grade.id;
    for (const key of ['same', 'notice', 'grade', 'salary', 'terminated', 'moved']) await hire(key);
    await hire('confirmed', false);
    unitId = await createRewardUnit(admin, { name: 'Refresh rewards', year, companyId: b.companyId, businessUnitId: buId, snapshotDate: earlier });
    const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'BU reviewer', primaryEmail: 'bu@refresh.test' }).returning();
    const userId = await createAppUser(b.tenantId, p.id, 'employee');
    bu = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
    await setRewardMember(admin, unitId, (await view()).unit.revision, userId, 'bu');
    const [reviewerEmployment]=await owner.db.select().from(schema.employment).where(eq(schema.employment.personId,p.id));ids.reviewer=reviewerEmployment.id;
    for (const row of (await view()).rows) {
      const recommendation = row.source.employmentId === ids.moved ? { ...row.recommendation, meritBp: 800, reason: 'Retained for the record' } : row.recommendation;
      await saveRewardEntry(admin, unitId, (await view()).unit.revision, row.id, recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    }
    // Personnel and Compensation change after the snapshot.
    await owner.db.update(schema.employment).set({ confirmationDate: today }).where(eq(schema.employment.id, ids.confirmed));
    await owner.db.update(schema.employment).set({ tenderResignationDate: today }).where(eq(schema.employment.id, ids.notice));
    const [g13] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '13', name: 'Grade 13' }).returning();
    await owner.db.update(schema.employment).set({ gradeId: g13.id }).where(eq(schema.employment.id, ids.grade));
    await setCompensation(admin, { employmentId: ids.salary, basicSalary: 6000, effectiveFrom: today });
    await owner.db.update(schema.employment).set({ terminatedOn: today }).where(eq(schema.employment.id, ids.terminated));
    await owner.db.update(schema.assignment).set({ validTo: today }).where(eq(schema.assignment.employmentId, ids.moved));
    await hire('joined');
  });
  afterAll(closeAll);

  it('previews every category by name without changing anything', async () => {
    const before = await view();
    const p = await previewRewardSourceRefresh(admin, unitId, before.unit.revision);
    expect(p).toMatchObject({ from: earlier, asOf: today });
    const names = (c: keyof typeof p.people) => p.people[c].map(x => x.employmentId);
    expect(names('joined').sort()).toEqual([ids.joined,ids.reviewer].sort());
    expect(names('left').sort()).toEqual([ids.terminated, ids.moved].sort());
    expect(names('confirmed')).toEqual([ids.confirmed]);
    expect(names('notice')).toEqual([ids.notice]);
    expect(names('grade')).toEqual([ids.grade]);
    expect(names('salary')).toEqual([ids.salary]);
    expect(names('other')).toEqual([]);
    const after = await view();
    expect(after.unit).toMatchObject({ revision: before.unit.revision, snapshotDate: earlier });
    expect(after.rows.map(r => [r.id, r.source, r.facts])).toEqual(before.rows.map(r => [r.id, r.source, r.facts]));
  });

  it('confirms: keeps leavers with zero awards, advances the snapshot, unverifies only changed people and records counts', async () => {
    const rev = (await view()).unit.revision, p = await previewRewardSourceRefresh(admin, unitId, rev);
    await saveRewardSourceRefresh(admin, unitId, rev, p.asOf, p.digest);
    const v = await view(), row = (key: string) => v.rows.find(r => r.source.employmentId === ids[key])!;
    expect(v.unit.snapshotDate).toBe(today);
    expect(v.rows).toHaveLength(9);
    expect(row('terminated').source).toMatchObject({ leftOn: today, leftReason: 'terminated' });
    expect(row('moved').source).toMatchObject({ leftOn: today, leftReason: 'moved' });
    expect(row('moved')).toMatchObject({ incrementReason: 'Left or moved out', bonusReason: 'Left or moved out', meritCents: 0, bonusCents: 0, lumpCents: 0 });
    expect(row('moved').recommendation.meritBp).toBe(800);
    expect(row('same').facts.reviewed).toBe(true);
    for (const key of ['joined','reviewer', 'terminated', 'moved', 'confirmed', 'notice', 'grade', 'salary']) expect(row(key).facts.reviewed, key).toBe(false);
    expect(row('salary').source.basicCents).toBe(600000);
    expect(row('notice').source.notice).toBe(true);
    const [event] = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, unitId), eq(schema.domainEvent.eventType, 'reward-unit.sources-refreshed')));
    expect(event.payload).toMatchObject({ from: earlier, asOf: today, changed: 8, counts: { joined: 2, left: 2, confirmed: 1, notice: 1, grade: 1, salary: 1, other: 0 } });
    // A second refresh finds nothing new: leavers are not re-counted.
    const again = await previewRewardSourceRefresh(admin, unitId, v.unit.revision);
    expect(Object.values(again.people).flat()).toEqual([]);
  });

  it('refuses a stale digest, a changed source, a wrong date window, a non-Group Rewards actor and a submitted review', async () => {
    const rev = (await view()).unit.revision, p = await previewRewardSourceRefresh(admin, unitId, rev);
    await expect(saveRewardSourceRefresh(admin, unitId, rev, p.asOf, 'f'.repeat(64))).rejects.toThrow(/Preview the refresh again/);
    await owner.db.update(schema.employment).set({ resignationDate: today }).where(eq(schema.employment.id, ids.same));
    await expect(saveRewardSourceRefresh(admin, unitId, rev, p.asOf, p.digest)).rejects.toThrow(/Preview the refresh again/);
    await expect(previewRewardSourceRefresh(admin, unitId, rev, `${year - 3}-01-01`)).rejects.toThrow(/on or after the current snapshot/);
    await expect(previewRewardSourceRefresh(admin, unitId, rev, `${year + 1}-12-31`)).rejects.toThrow(/future/);
    await expect(previewRewardSourceRefresh(bu, unitId, rev)).rejects.toThrow(/Only Group Rewards/);
    await owner.db.update(schema.rewardUnit).set({ status: 'bg' }).where(eq(schema.rewardUnit.id, unitId));
    await expect(previewRewardSourceRefresh(admin, unitId, rev)).rejects.toThrow(/Return the unit to draft/);
    expect((await view()).unit.snapshotDate).toBe(earlier);
  });
});
