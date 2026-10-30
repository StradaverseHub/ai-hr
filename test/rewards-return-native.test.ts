import {migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createRewardUnit,getRewardUnit,listRewardUnits,saveRewardEntry,decideRewardUnit,returnAnnualRewardReviewTx,returnAnnualRewardReview,reviewAnnualRewardReturnTx} from '../packs/rewards/service';
import {emptyFacts,type RewardRole} from '../packs/rewards/model';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
beforeAll(migrateRewardMembershipFixture);
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
describe('Native annual Rewards return seam', () => {
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
  async function submit() {
    let v = await view();
    await configureRewardFixture(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    for (const i of [0, 1]) { v = await view(); await saveRewardEntry(admin, unitId, v.unit.revision, v.rows[i].id, v.rows[i].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' }); }
    await refreshRewardFixtureBudget(admin,unitId);
    const rev = (await view()).unit.revision;
    expect(await decideRewardUnit(actors.bu!, unitId, rev, 'submit', 'Reviewed recommendations')).toBe('bg');
    return rev;
  }
  const events = (type: string) => owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, unitId), eq(schema.domainEvent.eventType, type))).orderBy(schema.domainEvent.id);
  afterAll(closeAll);

  const reason='Fictional recommendations need another BU review.';
  async function state(){return{unit:(await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId)))[0],entries:await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId)).orderBy(schema.rewardEntry.id),decisions:await owner.db.select().from(schema.rewardDecision).where(eq(schema.rewardDecision.unitId,unitId)).orderBy(schema.rewardDecision.id),events:await events('reward-unit.routed')};}
  it('preflights actual BG return without writing, exposing people or calculating money outside the native owner',async()=>{const rev=await submit(),before=await state(),preview=await withTenant(actors.bg!,tx=>reviewAnnualRewardReturnTx(tx,actors.bg!,unitId,rev));expect(preview).toMatchObject({unitId,companyId:b.companyId,revision:rev,before:'bg',after:'draft',returnedTo:'bu'});expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);expect(preview.decisionDigest).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(preview)).not.toMatch(/Fictional Reward Employee|"basicSalary"|"bonusCents"|"rows"|"entries"/);expect(await state()).toEqual(before);});
  it('uses the SAME native decision, resets approval/revision and retains every entry and prior decision',async()=>{const rev=await submit(),before=await state(),result=await returnAnnualRewardReview(actors.bg!,unitId,rev,reason),after=await state();expect(result.stage).toBe('draft');expect(result.source.before).toBe('bg');expect(after.unit).toMatchObject({status:'draft',revision:rev+1,approvedDigest:null});expect(after.entries).toEqual(before.entries);expect(after.decisions).toEqual(expect.arrayContaining(before.decisions));const added=after.decisions.filter(d=>!before.decisions.some(old=>old.id===d.id));expect(added).toHaveLength(1);expect(added[0]).toMatchObject({actorId:actors.bg!.userId,revision:rev,action:'return',fromStage:'bg',toStage:'draft',reason,digest:result.source.decisionDigest});const routed=after.events.filter(d=>!before.events.some(old=>old.id===d.id));expect(routed).toHaveLength(1);expect(routed[0].payload).toEqual({from:'bg',to:'draft',revision:rev});expect(routed[0].actorId).toBe(actors.bg!.userId);expect((await view()).returned).toMatchObject({reason,toSeat:'bu',fromStage:'bg'});});
  it('requires the actual current-stage seat and never treats an HR title/GR seat as a BG override',async()=>{const rev=await submit(),before=await state();for(const who of [admin,actors.bu!,actors.ctro!,actors.ec!])await expect(returnAnnualRewardReview(who,unitId,rev,reason)).rejects.toThrow();expect(await state()).toEqual(before);expect((await returnAnnualRewardReview(actors.bg!,unitId,rev,reason)).stage).toBe('draft');});
  it('refuses stale revision, draft return and a short reason without a native effect',async()=>{let before=await state();await expect(returnAnnualRewardReview(actors.bg!,unitId,before.unit.revision,reason)).rejects.toThrow();expect(await state()).toEqual(before);const rev=await submit();before=await state();await expect(returnAnnualRewardReview(actors.bg!,unitId,rev-1,reason)).rejects.toThrow();await expect(returnAnnualRewardReview(actors.bg!,unitId,rev,'short')).rejects.toThrow();expect(await state()).toEqual(before);});
  it('rolls the entire native unit/decision/event back when a supplied-Tx caller fails',async()=>{const rev=await submit(),before=await state();await expect(withTenant(actors.bg!,async tx=>{await returnAnnualRewardReviewTx(tx,actors.bg!,unitId,rev,reason);throw Error('Fictional outer custody refusal');})).rejects.toThrow('Fictional outer custody refusal');expect(await state()).toEqual(before);});
  it('preserves the legacy stage-only wrapper and native return reason',async()=>{const rev=await submit();expect(await decideRewardUnit(actors.bg!,unitId,rev,'return',reason)).toBe('draft');expect((await view()).returned).toMatchObject({reason,toSeat:'bu'});});
});
