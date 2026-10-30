/** Authored unrun native fixtures; private extraction candidate must clear review before application. */
import {createBatch} from '../packs/payroll/service';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {appendEvent,actorOf} from '../db/events';
import {erasePersonPii} from '../core/pdpa';
import {migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createOffcycleReview,postRewardUnit,createRewardUnit,getRewardUnit,listRewardUnits,saveRewardEntry,decideRewardUnit,submitAnnualRewardReviewTx,submitAnnualRewardReview,reviewAnnualRewardSubmitTx} from '../packs/rewards/service';
import {emptyFacts,type RewardRole} from '../packs/rewards/model';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
beforeAll(migrateRewardMembershipFixture);
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
describe('Native annual Rewards submission seam', () => {
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
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    for (const n of [1, 2]) {
      const hire = await hireEmployee(admin, { person: { fullName: `Fictional Reward Employee ${n}`, primaryEmail: `employee${n}@rewards-config.test` }, companyId: b.companyId, departmentId: b.deptA, businessUnitId:bu.id, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
      await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, hire.employmentId));
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
    await setRewardMember(admin, unitId, (await view()).unit.revision, admin.userId!, 'payroll');
  });
  /** Verify every employee and submit to the BG CEO; returns the revision the review is at. */
  async function draft() {
    let v = await view();
    await configureRewardFixture(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    for (const i of [0, 1]) { v = await view(); await saveRewardEntry(admin, unitId, v.unit.revision, v.rows[i].id, v.rows[i].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' }); }
    await refreshRewardFixtureBudget(admin,unitId);
    const rev = (await view()).unit.revision;
    return rev;
  }
  const events = (type: string) => owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, unitId), eq(schema.domainEvent.eventType, type))).orderBy(schema.domainEvent.id);
  afterAll(closeAll);

  const reason='I reviewed the recommendations and accept the native warnings.';
  async function state(){return{unit:(await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId)))[0],entries:await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId)).orderBy(schema.rewardEntry.id),decisions:await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId)).orderBy(schema.rewardDecision.id),events:await events('reward-unit.routed')};}
  it('runs full native preflight for the actual BU without a decision, unit update or audit effect',async()=>{const revision=await draft(),before=await state(),preview=await withTenant(actors.bu!,tx=>reviewAnnualRewardSubmitTx(tx,actors.bu!,unitId,revision,reason));expect(preview).toMatchObject({unitId,companyId:b.companyId,revision,before:'draft',after:'bg'});expect(preview.decisionDigest).toMatch(/^[a-f0-9]{64}$/);expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(preview)).not.toMatch(/Fictional Reward Employee|basicSalary|bonusCents|recommendation/);expect(await state()).toEqual(before);});
  it('uses SAME native submission and original audit at the SAME revision, retaining all entries and prior history',async()=>{const revision=await draft(),before=await state(),result=await submitAnnualRewardReview(actors.bu!,unitId,revision,reason),after=await state();expect(result.stage).toBe('bg');expect(after.unit).toMatchObject({status:'bg',revision,approvedDigest:result.source.decisionDigest});expect({...after.unit,status:before.unit.status,approvedDigest:before.unit.approvedDigest,updatedAt:before.unit.updatedAt}).toEqual(before.unit);expect(after.entries).toEqual(before.entries);expect(after.decisions).toEqual(expect.arrayContaining(before.decisions));const decisions=after.decisions.filter(row=>!before.decisions.some(old=>old.id===row.id));expect(decisions).toHaveLength(1);expect(decisions[0]).toMatchObject({actorId:actors.bu!.userId,revision,action:'submit',fromStage:'draft',toStage:'bg',reason,digest:result.source.decisionDigest});const added=after.events.filter(row=>!before.events.some(old=>old.id===row.id));expect(added).toHaveLength(1);expect(added[0].payload).toEqual({from:'draft',to:'bg',revision});expect(added[0].actorId).toBe(actors.bu!.userId);});
  it('requires a real active BU seat without giving HR, GR or other approval stages a BU override',async()=>{const revision=await draft(),before=await state();for(const who of [admin,actors.bg!,actors.ctro!,actors.ec!])await expect(submitAnnualRewardReview(who,unitId,revision,reason)).rejects.toThrow();expect(await state()).toEqual(before);expect((await submitAnnualRewardReview(actors.bu!,unitId,revision,reason)).stage).toBe('bg');});
  it('refuses missing native reviewed facts and blocking calculations before preparing or submitting',async()=>{const before=await state();await expect(withTenant(actors.bu!,tx=>reviewAnnualRewardSubmitTx(tx,actors.bu!,unitId,before.unit.revision,reason))).rejects.toThrow();await expect(submitAnnualRewardReview(actors.bu!,unitId,before.unit.revision,reason)).rejects.toThrow();expect(await state()).toEqual(before);});
  it('refuses stale revision and repeat BG submission without writing another decision or event',async()=>{const revision=await draft(),before=await state();await expect(submitAnnualRewardReview(actors.bu!,unitId,revision-1,reason)).rejects.toThrow();expect(await state()).toEqual(before);await submitAnnualRewardReview(actors.bu!,unitId,revision,reason);const submitted=await state();await expect(submitAnnualRewardReview(actors.bu!,unitId,revision,reason)).rejects.toThrow();expect(await state()).toEqual(submitted);});
  it('rolls the entire native unit/decision/event back when the outer custody transaction fails',async()=>{const revision=await draft(),before=await state();await expect(withTenant(actors.bu!,async tx=>{await submitAnnualRewardReviewTx(tx,actors.bu!,unitId,revision,reason);throw Error('Fictional submission custody failure');})).rejects.toThrow('Fictional submission custody failure');expect(await state()).toEqual(before);});
});
