import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import { withTenant,type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createAppUser,owner,closeAll,resetDb,migrateTestDb,seedBase,setModule,entitledCtx,type Base } from './harness';
import { createPreparingRewardUnit as createApprovedRewardUnit } from './rewards-setup-fixture';
import { initializeRewardGovernanceFixture,refreshRewardFixtureBudget } from './rewards-governance-fixture';
import { setRewardMember } from './rewards-access-fixture';
import { getRewardUnit,getRewardUnitGovernance,refreshRewardSources,importRewardFacts,getRewardPreparationStatus,getRewardPreparationChecklist,changeRewardPreparation,saveRewardUnitInputs,decideRewardUnit,rewardPreparationNotices,rewardDashboard,getRewardDashboardPreference,saveRewardDashboardPreference,rewardAccessAdministration,previewRewardAccessChange,saveRewardAccessChange } from '../packs/rewards/service';
import {dispatchNotificationsFromSweep} from '../core/notifications';
import { REWARD_PREPARATION_STEPS } from '../packs/rewards/preparation-model';

let base:Base,gr:SessionContext,checker:SessionContext,reviewer:SessionContext,unitId:string,employmentId:string;
const snapshotDate='2026-01-01';
async function change(ctx:SessionContext,command:Record<string,unknown>){
 const current=await getRewardPreparationChecklist(ctx,unitId);
 return changeRewardPreparation(ctx,unitId,current.revision,{...command,...(['confirm','release'].includes(String(command.kind))?{basis:current.basis}:{})});
}
async function confirmAll(){
 await change(gr,{kind:'expected',date:'2026-11-30'});
 for(const step of REWARD_PREPARATION_STEPS)await change(gr,{kind:'confirm',step});
}

describe('native checked preparation of new annual Rewards reviews',()=>{
 beforeAll(async()=>{await migrateTestDb();});afterAll(closeAll);
 beforeEach(async()=>{
  await resetDb();base=await seedBase();await setModule(base.tenantId,'rewards','active');gr=await entitledCtx(base);
  const [bu]=await owner.db.insert(schema.businessUnit).values({tenantId:base.tenantId,companyId:base.companyId,code:'PREP-BU',name:'Preparation unit'}).returning();
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:base.tenantId,code:'12',name:'Grade 12',rank:12}).returning();
  const subject=await hireEmployee(gr,{person:{fullName:'Fictional preparation employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,businessUnitId:bu.id,gradeId:grade.id,employmentType:'full_time',hiredOn:'2024-01-01'});
  employmentId=subject.employmentId;
  await owner.db.update(schema.employment).set({confirmationDate:'2024-04-01'}).where(eq(schema.employment.id,employmentId));
  await setCompensation(gr,{employmentId,basicSalary:5000,effectiveFrom:'2024-01-01'});
  unitId=await createApprovedRewardUnit(gr,{name:'Preparation fixture',year:2026,companyId:base.companyId,businessUnitId:bu.id,snapshotDate});
  const [maker]=await owner.db.select({personId:schema.appUser.personId}).from(schema.appUser).where(eq(schema.appUser.id,gr.userId!));gr={...gr,personId:maker.personId};
  checker=await initializeRewardGovernanceFixture(gr,unitId);
  const [p]=await owner.db.insert(schema.person).values({tenantId:base.tenantId,fullName:'Fictional BU reviewer',primaryEmail:randomUUID()+'@fixture.test'}).returning();
  const userId=await createAppUser(base.tenantId,p.id,'employee');reviewer={...gr,userId,personId:p.id,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  await setRewardMember(gr,unitId,(await getRewardUnit(gr,unitId)).unit.revision,userId,'bu');
  await refreshRewardSources(gr,unitId,(await getRewardUnit(gr,unitId)).unit.revision,snapshotDate);
  for(const actor of [gr,checker]){
   const current=await getRewardUnit(actor,unitId);
   const pending=current.rows.filter(row=>!row.facts.reviewed);
   if(pending.length)await importRewardFacts(actor,unitId,current.unit.revision,pending.map(row=>({employmentId:row.source.employmentId,facts:{...row.facts,talent:'STAR' as const,performance:'ME' as const,reviewed:true}})));
  }
  await refreshRewardFixtureBudget(gr,unitId);
 });

 it('withholds figures and setup from a scoped reviewer before checked release',async()=>{
  const notice=await getRewardPreparationStatus(reviewer,unitId);
  expect(notice).toMatchObject({required:true,released:false,setupVisible:false,preparation:null,stateForSetup:null,history:[]});
  await expect(getRewardUnit(reviewer,unitId)).rejects.toThrow();
  await expect(getRewardPreparationChecklist(reviewer,unitId)).rejects.toThrow();
  const records=await withTenant(reviewer,tx=>tx.select({source:schema.rewardEntry.source}).from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId)));
  expect(records).toEqual([]);
 });

 it('refuses an incomplete or self-checked release and admits the same existing review after independent release',async()=>{
  await expect(change(checker,{kind:'release'})).rejects.toThrow(/Complete/);
  await confirmAll();
  await expect(change(gr,{kind:'release'})).rejects.toThrow(/different Group Rewards/);
  const before=await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId));
  await change(checker,{kind:'release'});
  expect((await getRewardPreparationStatus(reviewer,unitId)).released).toBe(true);
  expect((await getRewardUnit(reviewer,unitId)).unit.id).toBe(unitId);
  expect(await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId))).toEqual(before);
 });

 it('binds a confirmation to its rendered basis and refuses a stale source view',async()=>{
  const previous=await getRewardPreparationChecklist(gr,unitId);
  const current=await getRewardUnit(gr,unitId),entry=current.rows.find(row=>row.source.employmentId===employmentId)!;
  await importRewardFacts(gr,unitId,current.unit.revision,[{employmentId,facts:{...entry.facts,segment:'Changed reviewed classification'}}]);
  const fresh=await getRewardPreparationChecklist(gr,unitId);
  await expect(changeRewardPreparation(gr,unitId,fresh.revision,{kind:'confirm',step:'data',basis:previous.basis})).rejects.toThrow(/changed/);
 });

 it('locks ordinary setup changes and clears old confirmations on a reasoned controlled change',async()=>{
  await confirmAll();await change(checker,{kind:'release'});
  const gov=await getRewardUnitGovernance(gr,unitId);
  await expect(saveRewardUnitInputs(gr,unitId,gov.revision,{...gov.inputs!,multiplierBp:12500},'Fictional changed multiplier')).rejects.toThrow(/locked/);
  await change(gr,{kind:'reopen',reason:'Fictional source correction needs rechecking'});
  const current=await getRewardPreparationChecklist(gr,unitId);
  expect(current.preparation.state).toBe('preparing');expect(current.preparation.steps).toEqual({});
  expect((await getRewardPreparationStatus(reviewer,unitId)).released).toBe(false);
 });

 it('withdraws release and appends one bounded invalidation event when a native source owner changes facts',async()=>{
  await confirmAll();await change(checker,{kind:'release'});
  // Model an independently authorized native source publisher, outside the setup form.
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`select set_config('app.tenant_id',${base.tenantId},true),set_config('app.user_id',${gr.userId!},true)`);
   await tx.execute(sql`update reward_entry set facts=jsonb_set(facts,'{segment}','"Native source correction"'::jsonb) where unit_id=${unitId}::uuid and employment_id=${employmentId}::uuid`);
  });
  expect((await getRewardPreparationStatus(reviewer,unitId)).released).toBe(false);
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,unitId),eq(schema.domainEvent.eventType,'reward-unit.preparation-invalidated')));
  expect(events).toHaveLength(1);expect(events[0].payload).toEqual({to:'draft',reason:'source-changed'});
  expect((await getRewardPreparationChecklist(gr,unitId)).preparation.steps).toEqual({});
 });

 it('projects dashboard totals only inside live scope and saves presentation for the current login',async()=>{
  const pending=await rewardDashboard(reviewer,[base.companyId],{scope:unitId});expect(pending.units).toEqual([]);expect(pending.notices).toHaveLength(1);expect(pending.notices[0].unitId).toBe(unitId);
  expect(await rewardPreparationNotices({...reviewer,userId:randomUUID(),personId:undefined})).toEqual([]);
  await confirmAll();await change(checker,{kind:'release'});
  const native=await getRewardUnit(gr,unitId),dashboard=await rewardDashboard(gr,[base.companyId],{scope:unitId,period:'annual'});
  expect(dashboard.units).toHaveLength(1);expect(dashboard.choice.period).toBe('annual');
  expect(dashboard.units[0].budgets?.standard.used).toEqual(native.budgets.standard.used);
  expect(dashboard.units[0].budgets?.standard.bonusPoolCents).toBe(native.budgets.standard.bonusPoolCents);
  expect(JSON.stringify(dashboard)).not.toContain('Fictional preparation employee');
  expect((await rewardDashboard(gr,[randomUUID()],{scope:unitId})).units).toEqual([]);
  await saveRewardDashboardPreference(gr,[base.companyId],{scope:unitId,period:'annual'});
  expect(await getRewardDashboardPreference(gr)).toEqual({scope:unitId,period:'annual'});
  expect(await getRewardDashboardPreference(reviewer)).toBeNull();
 });

 it('retains permitted BG aggregate contributions without returning a BG personal line',async()=>{
  const current=await getRewardUnit(gr,unitId),entry=current.rows.find(row=>row.source.employmentId===employmentId)!;
  await importRewardFacts(gr,unitId,current.unit.revision,[{employmentId,facts:{...entry.facts,confidentiality:'bg'}}]);
  await refreshRewardFixtureBudget(gr,unitId);await confirmAll();await change(checker,{kind:'release'});
  const permitted=await getRewardUnit(gr,unitId),review=await getRewardUnit(reviewer,unitId),dashboard=await rewardDashboard(reviewer,[base.companyId],{scope:unitId});
  expect(review.rows.some(row=>row.source.employmentId===employmentId)).toBe(false);
  expect(dashboard.units).toHaveLength(1);expect(dashboard.units[0].restricted).toBe(false);
  expect(dashboard.units[0].budgets?.standard.used).toEqual(permitted.budgets.standard.used);
  expect(JSON.stringify(dashboard)).not.toContain('Fictional preparation employee');
 });

 it('prevents even an inspection seat from advancing preparation and restarts an already-routed review on a controlled change',async()=>{
  const initial=await getRewardUnit(gr,unitId);
  await expect(decideRewardUnit(gr,unitId,initial.unit.revision,'approve','Fictional premature approval')).rejects.toThrow(/independently checked/);
  await expect(withTenant(gr,tx=>tx.update(schema.rewardUnit).set({status:'gr'}).where(eq(schema.rewardUnit.id,unitId)))).rejects.toMatchObject({cause:{message:expect.stringMatching(/independently checked/)}});
  await confirmAll();await change(checker,{kind:'release'});
  await withTenant(gr,tx=>tx.update(schema.rewardUnit).set({status:'gr'}).where(eq(schema.rewardUnit.id,unitId)));
  await withTenant(gr,tx=>tx.update(schema.rewardUnit).set({status:'draft'}).where(eq(schema.rewardUnit.id,unitId)));
  expect((await getRewardPreparationStatus(reviewer,unitId)).released).toBe(true);
  await withTenant(gr,tx=>tx.update(schema.rewardUnit).set({status:'gr'}).where(eq(schema.rewardUnit.id,unitId)));
  const routed=await getRewardPreparationChecklist(gr,unitId);expect(routed.canEdit).toBe(false);expect(routed.canReopen).toBe(true);
  await change(gr,{kind:'reopen',reason:'Fictional routed review needs a source correction'});
  expect((await getRewardUnit(gr,unitId)).unit.status).toBe('draft');expect((await getRewardPreparationChecklist(gr,unitId)).canEdit).toBe(true);
  expect((await getRewardPreparationStatus(reviewer,unitId)).released).toBe(false);
 });

 it('preserves historical GR setup editing without inventing release or step history',async()=>{
  await owner.db.execute(sql`update reward_unit set preparation_required=false where id=${unitId}::uuid`);
  const historical=await getRewardPreparationChecklist(gr,unitId);expect(historical.access.required).toBe(false);expect(historical.canEdit).toBe(true);expect(historical.preparation.steps).toEqual({});
  await expect(change(gr,{kind:'expected',date:'2026-11-30'})).rejects.toThrow(/Legacy review/);
  const gov=await getRewardUnitGovernance(gr,unitId);await saveRewardUnitInputs(gr,unitId,gov.revision,{...gov.inputs!,multiplierBp:11000},'Fictional legacy multiplier correction');
  expect((await getRewardPreparationChecklist(gr,unitId)).preparation.steps).toEqual({});
 });

 it('notifies the current pre-change approver once after the review returns to draft',async()=>{
  const recipient=await hireEmployee(gr,{person:{fullName:'Fictional current GR approver',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  const userId=await createAppUser(base.tenantId,recipient.personId,'employee');
  await setRewardMember(gr,unitId,(await getRewardUnit(gr,unitId)).unit.revision,userId,'gr');
  // Hiring the recipient changes the live roster: acknowledge that source change before release.
  await refreshRewardSources(gr,unitId,(await getRewardUnit(gr,unitId)).unit.revision,snapshotDate);
  for(const actor of [gr,checker]){
   const current=await getRewardUnit(actor,unitId),pending=current.rows.filter(row=>!row.facts.reviewed);
   if(pending.length)await importRewardFacts(actor,unitId,current.unit.revision,pending.map(row=>({employmentId:row.source.employmentId,facts:{...row.facts,talent:'STAR' as const,performance:'ME' as const,reviewed:true}})));
  }
  await refreshRewardFixtureBudget(gr,unitId);
  await confirmAll();await change(checker,{kind:'release'});
  await withTenant(gr,tx=>tx.update(schema.rewardUnit).set({status:'gr'}).where(eq(schema.rewardUnit.id,unitId)));
  await change(gr,{kind:'reopen',reason:'Fictional routed review correction requires a fresh check'});
  await setModule(base.tenantId,'notifications','active');const active=await entitledCtx(base),system:SessionContext={tenantId:base.tenantId,roles:['hr_admin'],entitlements:active.entitlements};
  const[event]=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,unitId),eq(schema.domainEvent.eventType,'reward-unit.preparation-changed')));
  expect(event.payload).toEqual({to:'gr'});expect((await getRewardUnit(gr,unitId)).unit.status).toBe('draft');
  await dispatchNotificationsFromSweep(system,owner);await dispatchNotificationsFromSweep(system,owner);
  const notices=await owner.db.select().from(schema.notification).where(and(eq(schema.notification.sourceEventId,event.id),eq(schema.notification.recipientEmploymentId,recipient.employmentId)));
  expect(notices).toHaveLength(1);expect(notices[0].kind).toBe('rewards.preparation-changed');expect(notices[0].linkPath).toBe(`/rewards/${unitId}`);
 });

 it('honors denied review pages and dated personal exceptions for waiting notices',async()=>{
  await owner.db.execute(sql`insert into reward_role_permission(tenant_id,role,capability,allowed,changed_by,reason) values(${base.tenantId}::uuid,'bu','review.view',false,${gr.userId!}::uuid,'Fictional restricted review page')`);
  await expect(getRewardPreparationStatus(reviewer,unitId)).rejects.toThrow(/access/);expect(await rewardPreparationNotices(reviewer)).toEqual([]);
  await owner.db.execute(sql`insert into reward_page_grant(tenant_id,user_id,company_id,capability,valid_from,valid_to,active,created_by,reason) values(${base.tenantId}::uuid,${reviewer.userId!}::uuid,${base.companyId}::uuid,'review.view','2020-01-01','2099-12-31',true,${gr.userId!}::uuid,'Fictional dated personal page exception')`);
  expect((await getRewardPreparationStatus(reviewer,unitId)).released).toBe(false);expect(await rewardPreparationNotices(reviewer)).toHaveLength(1);
  await owner.db.execute(sql`update reward_page_grant set valid_to='2020-12-31' where tenant_id=${base.tenantId}::uuid and user_id=${reviewer.userId!}::uuid`);
  await expect(getRewardPreparationStatus(reviewer,unitId)).rejects.toThrow(/access/);expect(await rewardPreparationNotices(reviewer)).toEqual([]);
 });

 it('keeps access administration available without disclosing a preparing review',async()=>{
  const [person]=await owner.db.insert(schema.person).values({tenantId:base.tenantId,fullName:'Fictional unseated HR administrator',primaryEmail:randomUUID()+'@fixture.test'}).returning();
  const userId=await createAppUser(base.tenantId,person.id,'hr_admin'),admin:SessionContext={...gr,userId,personId:person.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  await expect(getRewardUnit(admin,unitId)).rejects.toThrow();
  expect(await withTenant(admin,tx=>tx.select({source:schema.rewardEntry.source}).from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId)))).toEqual([]);
  const administration=await rewardAccessAdministration(admin,[base.companyId]);expect(administration.reviews.map(row=>row.id)).toContain(unitId);
  expect(JSON.stringify(administration.reviews)).not.toContain('basicCents');expect(JSON.stringify(administration.reviews)).not.toContain('policy');
  const input={unitId,revision:(await getRewardUnit(gr,unitId)).unit.revision,before:null,after:{userId:reviewer.userId!,role:'gr'},reason:'Fictional HR administrator proposes another preparation checker'};
  const preview=await previewRewardAccessChange(admin,input);const saved=await saveRewardAccessChange(admin,input,preview.digest);
  expect(saved.requestId).toBeTruthy();
  const requests=await owner.db.select().from(schema.rewardAccessRequest).where(eq(schema.rewardAccessRequest.id,saved.requestId));expect(requests).toHaveLength(1);
  await expect(getRewardUnit(admin,unitId)).rejects.toThrow();
  expect((await rewardAccessAdministration({...admin,tenantId:randomUUID()},[base.companyId])).reviews).toEqual([]);
 });

 it.each([false,true])('preserves native owner RLS behavior with preparation released=%s',async released=>{
  if(released){await confirmAll();await change(checker,{kind:'release'});}
  const role='board_rewards_owner_'+randomUUID().replaceAll('-',''),rollback=new Error('Rollback this ownership parity fixture');
  await expect(owner.client.begin(async connection=>{
   await connection.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT`);
   const [identity]=await connection`select pg_get_userbyid(relowner) as name from pg_class where oid='public.app_user'::regclass`;
   const parent=String(identity.name);expect(parent).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
   await connection.unsafe(`GRANT "${parent}",ai_hr_app TO "${role}"`);
   const [attributes]=await connection`select rolsuper,rolbypassrls from pg_roles where rolname=${role}`;
   expect(attributes).toMatchObject({rolsuper:false,rolbypassrls:false});
   // Preserve dedicated reader/invalidator identities and their forced-RLS policies. Only native
   // owner functions become the non-superuser schema owner, matching the staging ownership shape.
   const functions=await connection`select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.prosecdef and p.prokind='f' and p.proowner=(select relowner from pg_class where oid='public.app_user'::regclass) order by p.oid`;
   expect(functions.length).toBeGreaterThan(0);
   await connection.unsafe(functions.map(fn=>`ALTER FUNCTION ${String(fn.signature)} OWNER TO "${role}"`).join(';'));
   await connection.unsafe('SET LOCAL ROLE ai_hr_app');await connection.unsafe('SET LOCAL row_security=on');
   for(const actor of [gr,reviewer]){
    const roles=actor.roles??[],grants=actor.grants??roles.map(value=>({role:value,companyId:null}));
    await connection`select set_config('app.tenant_id',${actor.tenantId},true),set_config('app.user_id',${actor.userId??''},true),set_config('app.roles',${roles.join(',')},true),set_config('app.grants',${JSON.stringify(grants)},true),set_config('app.agent_principal_id','',true)`;
    const [view]=await connection`select app.reward_preparation_view(${unitId}::uuid) as value`;
    expect(view.value).toMatchObject({required:true,released,setupVisible:actor===gr});
    if(actor===reviewer){expect(view.value.preparation).toBeNull();expect(view.value.stateForSetup).toBeNull();}
    else expect(view.value.actorNames).toBeDefined();
   }
   await connection`select set_config('app.tenant_id',${randomUUID()},true)`;
   const [foreign]=await connection`select app.reward_preparation_view(${unitId}::uuid) as value`;expect(foreign.value).toBeNull();
   throw rollback;
  })).rejects.toBe(rollback);
 });

 it('keeps the preparation compatibility flag out of ordinary runtime control',async()=>{
  await expect(withTenant(gr,tx=>tx.execute(sql`update reward_unit set preparation_required=false where id=${unitId}::uuid`))).rejects.toThrow();
 });
});
