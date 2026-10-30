import {pgSqlState} from '../lib/db-error';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import * as vault from '../lib/pii/vault';
import {rewardsSubmitReviews as reviews} from '../core/assistant-actions/rewards-submit-review-store';
import {REWARDS_SUBMIT_ACTION as action} from '../lib/assistant-actions/rewards-submit-contract';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {appendEvent,actorOf} from '../db/events';
import {erasePersonPii} from '../core/pdpa';
import {migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createRewardUnit,getRewardUnit,listRewardUnits,saveRewardEntry,decideRewardUnit,submitAnnualRewardReviewTx,submitAnnualRewardReview,reviewAnnualRewardSubmitTx} from '../packs/rewards/service';
import {emptyFacts,type RewardRole} from '../packs/rewards/model';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
beforeAll(migrateRewardMembershipFixture);
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
describe('Encrypted annual Rewards submission custody', () => {
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
  afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
  async function enable(who=admin){vi.stubEnv('AI_CONFIG_SECRET','fictional-rewards-submit-key-123456');await setModule(b.tenantId,'assistant','active');await grantAssistant(admin,{appUserId:who.userId!});}
  async function prepare(){await enable(actors.bu!);const revision=await draft(),result=await reviews.prepare(actors.bu!,{action,contractVersion:1,unitId,revision,reason,confirmWholeAnnualReview:true,confirmNativeWarnings:true});if(result.kind!=='prepared')throw Error('Expected annual submission review');return result.review;}
  const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
  const retirement=(r:{actionId:string})=>({action,contractVersion:1,actionId:r.actionId});
  async function custody(id:string){const [r]=await owner.db.execute(sql`select r.state,r.intent_digest,r.reviewed_digest,r.rewards_posted_event_id,r.rewards_submit_decision_id,r.rewards_submit_snapshot,r.rewards_submit_completed_xid::text as sealed_xid,r.rewards_review_person_ids,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return r;}
  it('uses real encrypted custody and SAME native submission, captures every actual participant and replays without another effect',async()=>{const r=await prepare(),before=await view(),pending=await custody(r.actionId);expect(pending).toMatchObject({state:'awaiting_confirmation',bodies:1,rewards_submit_snapshot:expect.any(Object)});expect(JSON.stringify(r)).not.toMatch(/Fictional Reward Employee|basicSalary|nativeDecisionDigest|unitStableHash|wrappedDek|ciphertext/);const [sealed]=await owner.db.execute<{ciphertext:string}>(sql`select ciphertext from app.assistant_own_leave_review_content where action_id=${r.actionId}::uuid`);expect(sealed.ciphertext).not.toContain(reason);const done=await reviews.confirm(actors.bu!,confirmation(r));if(done.kind!=='completed')throw Error('Expected completed annual submission');expect(done.receipt.receipt).toMatchObject({unitId,submittedRevision:r.content.revision,currentRevision:r.content.revision,currentStatus:'bg'});const after=await view();expect(after.unit.status).toBe('bg');expect(after.rows).toEqual(before.rows);expect(await custody(r.actionId)).toMatchObject({state:'completed',bodies:0,rewards_submit_snapshot:null,rewards_review_person_ids:null,sealed_xid:expect.any(String)});const targets=await owner.db.execute<{kind:string;id:string}>(sql`select t.kind,t.target_id id from app.native_outcome_source_target t join app.native_outcome_source_capture c on c.id=t.capture_id where c.source_id=${r.actionId}::uuid order by t.kind,t.target_id`);expect(targets.length).toBeGreaterThan(0);const actual=await owner.db.execute<{kind:string;id:string}>(sql`select 'employment' kind,e.id from employment e join reward_entry re on re.employment_id=e.id and re.tenant_id=e.tenant_id where re.unit_id=${unitId}::uuid union select 'person' kind,e.person_id id from employment e join reward_entry re on re.employment_id=e.id and re.tenant_id=e.tenant_id where re.unit_id=${unitId}::uuid union select 'person' kind,${actors.bu!.personId}::uuid id order by kind,id`);expect(Array.from(targets)).toEqual(Array.from(actual));expect(await reviews.confirm(actors.bu!,confirmation(r))).toEqual(done);expect(await reviews.reopen(actors.bu!,r.actionId)).toEqual(done);await expect(reviews.discard(actors.bu!,retirement(r))).rejects.toThrow();});
  it('admits actual BU seat without an HR title and never grants GR an override',async()=>{await enable(actors.bu!);await enable(admin);const revision=await draft(),human={action,contractVersion:1 as const,unitId,revision,reason,confirmWholeAnnualReview:true as const,confirmNativeWarnings:true as const};await expect(reviews.prepare(admin,human)).rejects.toThrow();const r=await reviews.prepare(actors.bu!,human);if(r.kind!=='prepared')throw Error();expect((await reviews.confirm(actors.bu!,confirmation(r.review))).kind).toBe('completed');});
  it('refuses changed public digest, foreign USER and SYSTEM without native submission',async()=>{const r=await prepare(),before=(await view()).unit;await expect(reviews.confirm(actors.bu!,{...confirmation(r),reviewedDigest:'f'.repeat(64)})).rejects.toThrow();await expect(reviews.reopen(actors.bg!,r.actionId)).rejects.toThrow();await expect(reviews.prepare({...actors.bu!,userId:undefined},r.content)).rejects.toThrow();expect((await view()).unit).toEqual(before);});
  it('refuses revoked Assistant authority before unwrap while metadata discovery and discard remain available',async()=>{const r=await prepare();await revokeAssistant(admin,{appUserId:actors.bu!.userId!});const unwrap=vi.spyOn(vault,'unwrapDek');await expect(reviews.confirm(actors.bu!,confirmation(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();expect((await reviews.list(actors.bu!)).reviews.map(x=>x.actionId)).toContain(r.actionId);await reviews.discard(actors.bu!,retirement(r));expect(await custody(r.actionId)).toMatchObject({state:'discarded',bodies:0,rewards_submit_snapshot:null,rewards_review_person_ids:null});});
  it('refuses revoked actual BU seat before unwrap and leaves the native unit unchanged',async()=>{const r=await prepare(),before=(await view()).unit;const revoked=await owner.db.delete(schema.rewardMember).where(and(eq(schema.rewardMember.unitId,unitId),eq(schema.rewardMember.userId,actors.bu!.userId!),eq(schema.rewardMember.role,'bu'))).returning({id:schema.rewardMember.id});expect(revoked).toHaveLength(1);const unwrap=vi.spyOn(vault,'unwrapDek');await expect(reviews.confirm(actors.bu!,confirmation(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();expect((await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId)))[0].status).toBe(before.status);});
  it('expires and removes encrypted content and private participant proof without returning the unit',async()=>{const r=await prepare();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' where id=${r.actionId}::uuid`);expect((await reviews.confirm(actors.bu!,confirmation(r))).kind).toBe('retired');expect(await custody(r.actionId)).toMatchObject({state:'expired',bodies:0,rewards_submit_snapshot:null,rewards_review_person_ids:null});expect((await view()).unit.status).toBe('draft');});
  it('refuses corrupted real ciphertext without a native effect',async()=>{const r=await prepare(),before=(await view()).unit;await owner.db.execute(sql`update app.assistant_own_leave_review_content set ciphertext='corrupted-fictional-ciphertext' where action_id=${r.actionId}::uuid`);await expect(reviews.confirm(actors.bu!,confirmation(r))).rejects.toThrow();expect((await view()).unit).toEqual(before);});
  it('refuses login relink before unwrap and hides former-person metadata',async()=>{const r=await prepare(),[p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional relinked actor',primaryEmail:'relinked@return.test'}).returning();await owner.db.update(schema.appUser).set({personId:p.id}).where(eq(schema.appUser.id,actors.bu!.userId!));const who={...actors.bu!,personId:p.id},unwrap=vi.spyOn(vault,'unwrapDek');await expect(reviews.confirm(who,confirmation(r))).rejects.toThrow();expect((await reviews.list(who)).reviews).toEqual([]);await expect(reviews.discard(who,retirement(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();});
  it('real participant erasure atomically retires real encrypted annual-return custody',async()=>{const r=await prepare(),v=await view();await erasePersonPii(admin,{subjectEmploymentId:v.rows[0].source.employmentId,scope:'contact',requestRef:'FICTIONAL-RETURN-ERASURE',reason:'Fictional encrypted annual review erasure'});expect(await custody(r.actionId)).toMatchObject({state:'refused',bodies:0,rewards_submit_snapshot:null,rewards_review_person_ids:null});const result=await reviews.confirm(actors.bu!,confirmation(r));expect(result).toMatchObject({kind:'retired',receipt:{actionId:r.actionId,state:'refused'}});expect((await view()).unit.status).toBe('draft');});
  it('rejects every unrelated legacy column with typed 23514 rather than an accidental type error',async()=>{
    const r=await prepare();
    // Independent allowed cancellation metadata/receipt contract. Every remaining physical column
    // must be refused; unknown future types make the fixture fail rather than silently skip a field.
    const allowed=['action_kind','id','tenant_id','user_id','person_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','rewards_unit_id','rewards_posted_event_id','rewards_posted_revision','rewards_review_person_ids','rewards_submit_decision_id','rewards_submit_snapshot','rewards_submit_commitment','rewards_submit_completed_xid','rewards_submit_effect_xid'];
    const columns=await owner.db.execute<{name:string;type:string}>(sql`select attname as name,format_type(atttypid,atttypmod) as type from pg_attribute where attrelid='app.assistant_own_leave_review'::regclass and attnum>0 and not attisdropped order by attnum`);
    const hybrids=Array.from(columns).filter(c=>!allowed.includes(c.name));expect(hybrids.length).toBeGreaterThan(50);
    for(const c of hybrids){
      let value;
      if(c.type==='uuid')value=sql`${b.companyId}::uuid`;
      else if(c.type==='uuid[]')value=sql`array[${b.companyId}::uuid]::uuid[]`;
      else if(c.type==='text')value=sql`${c.name==='multi_cycle_pay_period'?'2026-10':c.name==='multi_cycle_run_type'?'bonus':'fictional'}`;
      else if(c.type==='integer')value=sql`1::integer`;
      else if(c.type==='date')value=sql`'2026-10-30'::date`;
      else if(c.type==='jsonb')value=sql`'{"fictional":true}'::jsonb`;
      else if(c.type==='xid8')value=sql`'1'::xid8`;
      else throw Error('Uncovered typed hybrid column '+c.name+': '+c.type);
      let caught:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(c.name)}=${value} where id=${r.actionId}::uuid`);}catch(error){caught=error;}
      expect(pgSqlState(caught),c.name+' ('+c.type+')').toBe('23514');
    }
    console.info('[rewards-submit-typed-hybrids]',hybrids.length,hybrids.map(c=>c.name));
    expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});expect((await view()).unit.status).toBe('draft');
  });

});
