import {pgSqlState} from '../lib/db-error';
import * as vault from '../lib/pii/vault';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {prepareRewardsCancelReview,confirmRewardsCancelReview,reopenRewardsCancelReview,discardRewardsCancelReview,listRewardsCancelReviews} from '../core/assistant-actions/rewards-cancel-review-store';
import {REWARDS_CANCEL_ACTION as action} from '../lib/assistant-actions/rewards-cancel-contract';
import {establishRewardMembership,migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget,changeRewardFixtureInputs,completeRewardFixturePolicy} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { cancelRewardReviewTx, cancelRewardReview, createRewardUnit, decideRewardUnit, emptyRewardCalendar, getRewardUnit, listRewardReviewStatus, listRewardUnits, pendingRewardTasks, rewardApprovalsBoard, saveRewardCalendar, saveRewardEntry, saveRewardPolicy } from '../packs/rewards/service';
import { emptyFacts, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

beforeAll(migrateRewardMembershipFixture);
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
describe('Rewards cancellation custody and exact proof', () => {
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
  const events = (type: string) => owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, unitId), eq(schema.domainEvent.eventType, type)));
  afterAll(closeAll);

  afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
  async function enable(){vi.stubEnv('AI_CONFIG_SECRET','fictional-rewards-cancel-key-123456');await setModule(b.tenantId,'assistant','active');await grantAssistant(admin,{appUserId:admin.userId!});}
  async function prepare(){await enable();const revision=(await view()).unit.revision;const result=await prepareRewardsCancelReview(admin,{action,contractVersion:1,unitId,revision,reason:'Fictional duplicate review cancellation',confirmWholeReview:true});if(result.kind!=='prepared')throw Error('Expected review');return result.review;}
  const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
  const retirement=(r:{actionId:string})=>({action,contractVersion:1,actionId:r.actionId});
  async function custody(id:string){const [r]=await owner.db.execute(sql`select r.state,r.intent_digest,r.reviewed_digest,r.rewards_posted_event_id,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return r;}
  it('prepares without effect, completes exact native event, retires encrypted body and recovers without duplicate cancellation',async()=>{
    const r=await prepare();const [constraintMetric]=await owner.db.execute(sql`select count(*)::int as count,sum(pg_column_size(conbin))::bigint::text as stored_bytes from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and contype='c'`);console.info('[rewards-custody-constraint-storage]',constraintMetric);expect(r.review).toMatchObject({companyId:b.companyId,companyName:'Acme Sdn Bhd',name:'Fictional Annual Compensation Review · HQ',before:'draft'});expect(r.review.after).toBe('withdrawn');expect(JSON.stringify(r)).not.toMatch(/Fictional Reward Employee|basicSalary|5000/);expect((await view()).unit.status).toBe('draft');expect(await events('reward-unit.cancelled')).toHaveLength(0);
    const done=await confirmRewardsCancelReview(admin,confirmation(r));expect(done.kind).toBe('completed');if(done.kind!=='completed')throw Error();
    const [event]=await events('reward-unit.cancelled');expect(done.receipt.receipt).toMatchObject({unitId,eventId:event.id,cancelledRevision:r.content.revision,currentRevision:r.content.revision+1,currentStatus:'withdrawn'});
    expect(await custody(r.actionId)).toMatchObject({state:'completed',bodies:0,intent_digest:null,reviewed_digest:null,rewards_posted_event_id:event.id});
    expect(await confirmRewardsCancelReview(admin,confirmation(r))).toEqual(done);expect(await reopenRewardsCancelReview(admin,r.actionId)).toEqual(done);expect(await events('reward-unit.cancelled')).toHaveLength(1);await expect(discardRewardsCancelReview(admin,retirement(r))).rejects.toThrow();
  });
  it('refuses stale native revision without cancellation',async()=>{const r=await prepare(),v=await view();await saveRewardEntry(admin,unitId,v.unit.revision,v.rows[0].id,v.rows[0].recommendation);await expect(confirmRewardsCancelReview(admin,confirmation(r))).rejects.toThrow();expect(await events('reward-unit.cancelled')).toHaveLength(0);});
  it('refuses changed public digest, foreign user and SYSTEM without effect',async()=>{const r=await prepare();await expect(confirmRewardsCancelReview(admin,{...confirmation(r),reviewedDigest:'f'.repeat(64)})).rejects.toThrow();await expect(reopenRewardsCancelReview(actors.bu!,r.actionId)).rejects.toThrow();await expect(prepareRewardsCancelReview({...admin,userId:undefined},r.content)).rejects.toThrow();expect(await events('reward-unit.cancelled')).toHaveLength(0);});
  it('requires native cancellation authority even for an Assistant-enabled BU seat',async()=>{await enable();await grantAssistant(admin,{appUserId:actors.bu!.userId!});const revision=(await view()).unit.revision;await expect(prepareRewardsCancelReview(actors.bu!,{action,contractVersion:1,unitId,revision,reason:'Fictional unauthorized cancellation',confirmWholeReview:true})).rejects.toThrow();});
  it('supports a real unlinked administrator USER without fabricated employment/person',async()=>{await enable();await owner.db.update(schema.appUser).set({personId:null}).where(eq(schema.appUser.id,admin.userId!));const who={...admin,personId:null},revision=(await getRewardUnit(who,unitId)).unit.revision,r=await prepareRewardsCancelReview(who,{action,contractVersion:1,unitId,revision,reason:'Fictional unlinked administrator cancellation',confirmWholeReview:true});if(r.kind!=='prepared')throw Error();expect((await confirmRewardsCancelReview(who,confirmation(r.review))).kind).toBe('completed');});
  it('admits an actual Group Rewards seat holder without imposing an HR role',async()=>{await enable();const who=actors.bg!;await setRewardMember(admin,unitId,(await view()).unit.revision,who.userId!,'gr');await grantAssistant(admin,{appUserId:who.userId!});const revision=(await view()).unit.revision,result=await prepareRewardsCancelReview(who,{action,contractVersion:1,unitId,revision,reason:'Fictional Group Rewards cancellation',confirmWholeReview:true});if(result.kind!=='prepared')throw Error();const done=await confirmRewardsCancelReview(who,confirmation(result.review));expect(done.kind).toBe('completed');if(done.kind!=='completed')throw Error();expect(await withTenant(who,tx=>tx.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(eq(schema.domainEvent.id,done.receipt.receipt.eventId)))).toEqual([]);});
  it('refuses revoked Assistant authority before effect while allowing metadata discovery and retirement',async()=>{const r=await prepare();await revokeAssistant(admin,{appUserId:admin.userId!});await expect(confirmRewardsCancelReview(admin,confirmation(r))).rejects.toThrow();expect((await listRewardsCancelReviews(admin)).reviews.map(x=>x.actionId)).toContain(r.actionId);await discardRewardsCancelReview(admin,retirement(r));expect(await custody(r.actionId)).toMatchObject({state:'discarded',bodies:0});expect(await events('reward-unit.cancelled')).toHaveLength(0);});
  it('expires without effect and removes encrypted content',async()=>{const r=await prepare();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' where id=${r.actionId}::uuid`);expect((await confirmRewardsCancelReview(admin,confirmation(r))).kind).toBe('retired');expect(await custody(r.actionId)).toMatchObject({state:'expired',bodies:0});expect(await events('reward-unit.cancelled')).toHaveLength(0);});
  it('rejects a fabricated or historical native proof at SQL completion and preserves pending custody',async()=>{const r=await prepare();await expect(withTenant(admin,tx=>tx.execute(sql`select app.assistant_rewards_cancel_review_complete(${r.actionId}::uuid,${r.reviewedDigest},gen_random_uuid(),${r.content.revision},null)`))).rejects.toThrow();expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});expect(await events('reward-unit.cancelled')).toHaveLength(0);});
  it('refuses corrupted ciphertext without a native effect',async()=>{const r=await prepare();await owner.db.execute(sql`update app.assistant_own_leave_review_content set ciphertext='corrupted-fictional-ciphertext' where action_id=${r.actionId}::uuid`);await expect(confirmRewardsCancelReview(admin,confirmation(r))).rejects.toThrow();expect(await events('reward-unit.cancelled')).toHaveLength(0);});
  it('refuses actual login relink before unwrapping and hides former-person metadata',async()=>{const r=await prepare(),[p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional relinked actor',primaryEmail:'relinked@cancel.test'}).returning();await owner.db.update(schema.appUser).set({personId:p.id}).where(eq(schema.appUser.id,admin.userId!));const who={...admin,personId:p.id},unwrap=vi.spyOn(vault,'unwrapDek');await expect(confirmRewardsCancelReview(who,confirmation(r))).rejects.toThrow();expect((await listRewardsCancelReviews(who)).reviews).toEqual([]);await expect(discardRewardsCancelReview(who,retirement(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();expect(await events('reward-unit.cancelled')).toHaveLength(0);});
  it('rejects every unrelated legacy column with typed 23514 rather than an accidental type error',async()=>{
    const r=await prepare();
    // Independent allowed cancellation metadata/receipt contract. Every remaining physical column
    // must be refused; unknown future types make the fixture fail rather than silently skip a field.
    const allowed=['action_kind','id','tenant_id','user_id','person_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','rewards_unit_id','rewards_posted_event_id','rewards_posted_revision','rewards_review_person_ids'];
    const columns=await owner.db.execute<{name:string;type:string}>(sql`select attname as name,format_type(atttypid,atttypmod) as type from pg_attribute where attrelid='app.assistant_own_leave_review'::regclass and attnum>0 and not attisdropped order by attnum`);
    const hybrids=Array.from(columns).filter(c=>!allowed.includes(c.name));expect(hybrids.length).toBeGreaterThan(50);
    for(const c of hybrids){
      let value;
      if(c.type==='uuid')value=sql`${b.companyId}::uuid`;
      else if(c.type==='uuid[]')value=sql`array[${b.companyId}::uuid]::uuid[]`;
      else if(c.type==='text')value=sql`${c.name==='multi_cycle_pay_period'?'2026-10':c.name==='multi_cycle_run_type'?'bonus':'fictional'}`;
      else if(c.type==='integer')value=sql`1::integer`;
      else if(c.type==='boolean')value=sql`true::boolean`;
      else if(c.type==='date')value=sql`'2026-10-30'::date`;
      else throw Error('Uncovered typed hybrid column '+c.name+': '+c.type);
      let caught:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(c.name)}=${value} where id=${r.actionId}::uuid`);}catch(error){caught=error;}
      expect(pgSqlState(caught),c.name+' ('+c.type+')').toBe('23514');
    }
    console.info('[rewards-cancellation-typed-hybrids]',hybrids.length,hybrids.map(c=>c.name));
    expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});expect(await events('reward-unit.cancelled')).toHaveLength(0);
  });
  it('refuses child-savepoint native cancellation as top-level completion and rolls the whole transaction back',async()=>{const r=await prepare();await expect(withTenant(admin,async tx=>{const native=await tx.transaction(inner=>cancelRewardReviewTx(inner,admin,unitId,r.content.revision,r.content.reason));await tx.execute(sql`select app.assistant_rewards_cancel_review_complete(${r.actionId}::uuid,${r.reviewedDigest},${native.eventId}::uuid,${native.cancelledRevision},null)`);})).rejects.toThrow();expect(await events('reward-unit.cancelled')).toHaveLength(0);expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});expect((await confirmRewardsCancelReview(admin,confirmation(r))).kind).toBe('completed');});

});
