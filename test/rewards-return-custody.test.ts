import {pgSqlState} from '../lib/db-error';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import * as vault from '../lib/pii/vault';
import {rewardsReturnReviews as reviews} from '../core/assistant-actions/rewards-return-review-store';
import {REWARDS_RETURN_ACTION as action} from '../lib/assistant-actions/rewards-return-contract';
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
import {createRewardUnit,getRewardUnit,listRewardUnits,saveRewardEntry,decideRewardUnit,returnAnnualRewardReviewTx,returnAnnualRewardReview,reviewAnnualRewardReturnTx} from '../packs/rewards/service';
import {emptyFacts,type RewardRole} from '../packs/rewards/model';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
import {assertAiPrincipalTx} from '../core/ai-principal';
import {readRewardsReturnChoicesTx} from '../core/assistant-actions/rewards-return-source';
beforeAll(migrateRewardMembershipFixture);
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
describe('Encrypted annual Rewards return custody', () => {
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
  afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
  async function enable(who=admin){vi.stubEnv('AI_CONFIG_SECRET','fictional-rewards-return-key-123456');await setModule(b.tenantId,'assistant','active');await grantAssistant(admin,{appUserId:who.userId!});}
  async function prepare(){await enable();await submit();let rev=(await view()).unit.revision;await decideRewardUnit(actors.bg!,unitId,rev,'approve','Fictional first-stage approval');rev=(await view()).unit.revision;const result=await reviews.prepare(admin,{action,contractVersion:1,unitId,revision:rev,reason,confirmWholeAnnualReview:true});if(result.kind!=='prepared')throw Error('Expected annual review');return result.review;}
  const confirmation=(r:{actionId:string;reviewedDigest:string})=>({action,contractVersion:1,actionId:r.actionId,reviewedDigest:r.reviewedDigest});
  const retirement=(r:{actionId:string})=>({action,contractVersion:1,actionId:r.actionId});
  async function custody(id:string){const [r]=await owner.db.execute(sql`select r.state,r.intent_digest,r.reviewed_digest,r.rewards_posted_event_id,r.rewards_return_decision_id,r.rewards_return_snapshot,r.rewards_return_completed_xid::text as sealed_xid,r.rewards_review_person_ids,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return r;}
  it('qualifies shared read-only annual choices/index while native command guards and busy refusal remain intact',async()=>{
    const review=await prepare(),before=await view();
    const identitySignature='app._assistant_rewards_return_review_identity(uuid,boolean,boolean)',choicesSignature='app.assistant_rewards_return_choices()',indexSignature='app.assistant_rewards_return_reviews_index()';
    // pg_get_functiondef normalizes whitespace; reparsing it moves only the parser source offsets
    // inside argument defaults. Compare every other byte plus the independently rendered defaults.
    const snapshot=async(name:string)=>{const [r]=await owner.client<{ddl:string;attributes:Record<string,unknown>;defaults:string|null}[]>`
      select pg_get_functiondef(oid)as ddl,
       jsonb_set(to_jsonb(p)-'prosrc','{proargdefaults}',coalesce(to_jsonb(regexp_replace(proargdefaults::text,':location -?[0-9]+',':location <source>','g')),'null'::jsonb))as attributes,
       pg_get_expr(proargdefaults,0)as defaults from pg_proc p where oid=${name}::regprocedure`;return r;};
    const identity=await snapshot(identitySignature),choices=await snapshot(choicesSignature),index=await snapshot(indexSignature);
    const exclusive="pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0))";
    expect(identity.ddl.split(exclusive)).toHaveLength(2);
    const shared="pg_try_advisory_xact_lock_shared(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0))";
    const candidateIdentity=identity.ddl.replace(exclusive,`(CASE WHEN p_write IS FALSE AND current_setting('transaction_read_only')='on' THEN ${shared} ELSE ${exclusive} END)`);
    const call='app._assistant_rewards_return_review_identity(NULL,false)';expect(choices.ddl.split(call)).toHaveLength(2);
    const candidateChoices=choices.ddl.replace(call,'app._assistant_rewards_return_review_identity(NULL,false,false)');
    const readIndex=(who=admin,readOnly=true)=>withTenant(who,async tx=>{
      if(readOnly)await tx.execute(sql`set transaction read only`);
      await assertAiPrincipalTx(tx,who);
      return Array.from(await tx.execute(sql`select * from app.assistant_rewards_return_reviews_index()`));
    });
    const readChoices=(readOnly=true)=>withTenant(admin,async tx=>{
      if(readOnly)await tx.execute(sql`set transaction read only`);
      return readRewardsReturnChoicesTx(tx,admin);
    });
    const underReader=<T,>(work:()=>Promise<T>)=>owner.client.begin(async holder=>{
      await holder`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))`;return work();
    });
    try{
      const expectedIndex=await readIndex(admin,false),expectedChoices=await readChoices(false);
      expect(expectedIndex).toHaveLength(1);expect(expectedIndex[0].action_id).toBe(review.actionId);
      expect(expectedChoices.units.map(unit=>unit.unitId)).toContain(unitId);
      const oldBusy=await underReader(()=>readIndex()).then(()=>null,(error:unknown)=>error);expect(pgSqlState(oldBusy)).toBe('55P03');
      await expect(readChoices()).rejects.toBeTruthy();
      await owner.client.unsafe(candidateIdentity);await owner.client.unsafe(candidateChoices);
      expect(await underReader(()=>readIndex())).toEqual(expectedIndex);
      expect(await underReader(()=>readChoices())).toEqual(expectedChoices);
      expect(await readIndex(admin,false)).toEqual(expectedIndex);expect(await readChoices(false)).toEqual(expectedChoices);
      for(const readOnly of [true,false])await withTenant(admin,async tx=>{
        if(readOnly)await tx.execute(sql`set transaction read only`);
        await tx.execute(sql`select * from app.assistant_rewards_return_reviews_index()`);
        const observed=await owner.client.begin(async observer=>{
          const [r]=await observer`select pg_try_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))as reader,
            pg_try_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))as writer`;return r;
        });expect(observed).toEqual({reader:readOnly,writer:false});
      });
      await owner.client.begin(async writer=>{
        await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
        const refused=await withTenant(admin,tx=>tx.execute(sql`select * from app.assistant_rewards_return_reviews_index()`)).then(()=>null,(error:unknown)=>error);
        expect(pgSqlState(refused)).toBe('55P03');
      });
      expect((await snapshot(identitySignature)).attributes).toEqual(identity.attributes);
      expect((await snapshot(choicesSignature)).attributes).toEqual(choices.attributes);expect(await snapshot(indexSignature)).toEqual(index);
      expect(await view()).toEqual(before);expect(await custody(review.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
      const done=await reviews.confirm(admin,confirmation(review));expect(done.kind).toBe('completed');expect((await view()).unit.status).toBe('draft');
    }finally{
      await owner.client.unsafe(choices.ddl);await owner.client.unsafe(identity.ddl);
      expect(await snapshot(identitySignature)).toEqual(identity);expect(await snapshot(choicesSignature)).toEqual(choices);expect(await snapshot(indexSignature)).toEqual(index);
    }
  });
  it('uses real encrypted custody and SAME native return, captures every actual participant and replays without another effect',async()=>{const r=await prepare(),before=await view(),pending=await custody(r.actionId);expect(pending).toMatchObject({state:'awaiting_confirmation',bodies:1,rewards_return_snapshot:expect.any(Object)});expect(JSON.stringify(r)).not.toMatch(/Fictional Reward Employee|basicSalary|nativeDecisionDigest|unitStableHash|wrappedDek|ciphertext/);const [sealed]=await owner.db.execute<{ciphertext:string}>(sql`select ciphertext from app.assistant_own_leave_review_content where action_id=${r.actionId}::uuid`);expect(sealed.ciphertext).not.toContain(reason);const done=await reviews.confirm(admin,confirmation(r));if(done.kind!=='completed')throw Error('Expected completed annual return');expect(done.receipt.receipt).toMatchObject({unitId,returnedRevision:r.content.revision,currentRevision:r.content.revision+1,currentStatus:'draft'});const after=await view();expect(after.unit.status).toBe('draft');expect(after.rows).toEqual(before.rows);expect(await custody(r.actionId)).toMatchObject({state:'completed',bodies:0,rewards_return_snapshot:null,rewards_review_person_ids:null,sealed_xid:expect.any(String)});const targets=await owner.db.execute<{kind:string;id:string}>(sql`select t.kind,t.target_id id from app.native_outcome_source_target t join app.native_outcome_source_capture c on c.id=t.capture_id where c.source_id=${r.actionId}::uuid order by t.kind,t.target_id`);expect(targets.length).toBeGreaterThan(0);const actual=await owner.db.execute<{kind:string;id:string}>(sql`select 'employment' kind,e.id from employment e join reward_entry re on re.employment_id=e.id and re.tenant_id=e.tenant_id where re.unit_id=${unitId}::uuid union select 'person' kind,e.person_id id from employment e join reward_entry re on re.employment_id=e.id and re.tenant_id=e.tenant_id where re.unit_id=${unitId}::uuid union select 'person' kind,${admin.personId}::uuid id order by kind,id`);expect(Array.from(targets)).toEqual(Array.from(actual));expect(await reviews.confirm(admin,confirmation(r))).toEqual(done);expect(await reviews.reopen(admin,r.actionId)).toEqual(done);await expect(reviews.discard(admin,retirement(r))).rejects.toThrow();});
  it('admits actual BG seat without an HR title and never grants another stage seat an override',async()=>{await enable(actors.bg!);const revision=await submit(),human={action,contractVersion:1 as const,unitId,revision,reason,confirmWholeAnnualReview:true as const};await expect(reviews.prepare(admin,human)).rejects.toThrow();const r=await reviews.prepare(actors.bg!,human);if(r.kind!=='prepared')throw Error();expect((await reviews.confirm(actors.bg!,confirmation(r.review))).kind).toBe('completed');});
  it('refuses changed public digest, foreign USER and SYSTEM without native return',async()=>{const r=await prepare(),before=(await view()).unit;await expect(reviews.confirm(admin,{...confirmation(r),reviewedDigest:'f'.repeat(64)})).rejects.toThrow();await expect(reviews.reopen(actors.bu!,r.actionId)).rejects.toThrow();await expect(reviews.prepare({...admin,userId:undefined},r.content)).rejects.toThrow();expect((await view()).unit).toEqual(before);});
  it('refuses revoked Assistant authority before unwrap while metadata discovery and discard remain available',async()=>{const r=await prepare();await revokeAssistant(admin,{appUserId:admin.userId!});const unwrap=vi.spyOn(vault,'unwrapDek');await expect(reviews.confirm(admin,confirmation(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();expect((await reviews.list(admin)).reviews.map(x=>x.actionId)).toContain(r.actionId);await reviews.discard(admin,retirement(r));expect(await custody(r.actionId)).toMatchObject({state:'discarded',bodies:0,rewards_return_snapshot:null,rewards_review_person_ids:null});});
  it('refuses revoked actual GR seat before unwrap and leaves the native unit unchanged',async()=>{const r=await prepare(),before=(await view()).unit;await owner.db.delete(schema.rewardMember).where(and(eq(schema.rewardMember.unitId,unitId),eq(schema.rewardMember.userId,admin.userId!),eq(schema.rewardMember.role,'gr')));const unwrap=vi.spyOn(vault,'unwrapDek');await expect(reviews.confirm(admin,confirmation(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();expect((await owner.db.select().from(schema.rewardUnit).where(eq(schema.rewardUnit.id,unitId)))[0].status).toBe(before.status);});
  it('expires and removes encrypted content and private participant proof without returning the unit',async()=>{const r=await prepare();await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=now()-interval '20 minutes',expires_at=now()-interval '10 minutes' where id=${r.actionId}::uuid`);expect((await reviews.confirm(admin,confirmation(r))).kind).toBe('retired');expect(await custody(r.actionId)).toMatchObject({state:'expired',bodies:0,rewards_return_snapshot:null,rewards_review_person_ids:null});expect((await view()).unit.status).toBe('gr');});
  it('refuses corrupted real ciphertext without a native effect',async()=>{const r=await prepare(),before=(await view()).unit;await owner.db.execute(sql`update app.assistant_own_leave_review_content set ciphertext='corrupted-fictional-ciphertext' where action_id=${r.actionId}::uuid`);await expect(reviews.confirm(admin,confirmation(r))).rejects.toThrow();expect((await view()).unit).toEqual(before);});
  it('refuses login relink before unwrap and hides former-person metadata',async()=>{const r=await prepare(),[p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional relinked actor',primaryEmail:'relinked@return.test'}).returning();await owner.db.update(schema.appUser).set({personId:p.id}).where(eq(schema.appUser.id,admin.userId!));const who={...admin,personId:p.id},unwrap=vi.spyOn(vault,'unwrapDek');await expect(reviews.confirm(who,confirmation(r))).rejects.toThrow();expect((await reviews.list(who)).reviews).toEqual([]);await expect(reviews.discard(who,retirement(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();});
  it('real participant erasure atomically retires real encrypted annual-return custody',async()=>{const r=await prepare(),v=await view();await erasePersonPii(admin,{subjectEmploymentId:v.rows[0].source.employmentId,scope:'contact',requestRef:'FICTIONAL-RETURN-ERASURE',reason:'Fictional encrypted annual review erasure'});expect(await custody(r.actionId)).toMatchObject({state:'refused',bodies:0,rewards_return_snapshot:null,rewards_review_person_ids:null});const result=await reviews.confirm(admin,confirmation(r));expect(result).toMatchObject({kind:'retired',receipt:{actionId:r.actionId,state:'refused'}});expect((await view()).unit.status).toBe('gr');});
  it('rejects every unrelated legacy column with typed 23514 rather than an accidental type error',async()=>{
    const r=await prepare();
    // Independent allowed cancellation metadata/receipt contract. Every remaining physical column
    // must be refused; unknown future types make the fixture fail rather than silently skip a field.
    const allowed=['action_kind','id','tenant_id','user_id','person_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','rewards_unit_id','rewards_posted_event_id','rewards_posted_revision','rewards_review_person_ids','rewards_return_decision_id','rewards_return_snapshot','rewards_return_commitment','rewards_return_completed_xid'];
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
      else if(c.type==='boolean')value=sql`true::boolean`;else if(c.type==='tid')value=sql`'(0,1)'::tid`;else throw Error('Uncovered typed hybrid column '+c.name+': '+c.type);
      let caught:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(c.name)}=${value} where id=${r.actionId}::uuid`);}catch(error){caught=error;}
      expect(pgSqlState(caught),c.name+' ('+c.type+')').toBe('23514');
    }
    console.info('[rewards-return-typed-hybrids]',hybrids.length,hybrids.map(c=>c.name));
    expect(await custody(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});expect((await view()).unit.status).toBe('gr');
  });

});
