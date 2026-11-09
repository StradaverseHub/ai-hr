/** Native presentation reads: actual application LOGIN, RLS and unchanged audit WRITE prephase. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {withModulePresentationRead} from '../core/module-presentation-read';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {todayInKualaLumpur} from '../lib/hr-date';
import {cancelRewardReview,emptyRewardCalendar,listRewardReviewStatus,listRewardUnits,observeRewardPlanLandingAccess,rewardConfigurationListView,rewardCoverageForUnits,saveRewardCalendar,type RewardConfigurationFilters} from '../packs/rewards/service';
import {rewardUnitCoverage} from '../packs/rewards/coverage';
import {rewardWholeGroupSetupCompanies,saveRewardGroupRole} from '../packs/rewards/group-roles';
import {rewardSetupPlanChoices} from '../packs/rewards/plan-configuration';
import {rewardRulesChoices} from '../packs/rewards/applied-rules';
import {saveUploadedRewards,confirmUploadedRewards,refreshUploadedRewardSources} from '../packs/rewards/uploaded-awards';
import {beginRewardViewAs,endRewardViewAs} from '../packs/rewards/access-policy';
import {emptyFacts} from '../packs/rewards/model';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
import {createApprovedRewardUnit,setupCompanyStructureFixture} from './rewards-setup-fixture';
import {legacyRewardConfigurationListTx} from './helpers/rewards-configuration-list-legacy';
import {observeNativeRead} from './helpers/native-read-observer';

beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.restoreAllMocks());afterAll(closeAll);
const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
async function fixture(){
 const b=await seedBase();await setModule(b.tenantId,'rewards','active');
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional snapshot operator',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 await owner.db.update(s.appUser).set({personId:person.id}).where(eq(s.appUser.id,b.adminUserId));
 const ctx={...await entitledCtx(b),personId:person.id,grants:[{role:'hr_admin',companyId:null}]} satisfies SessionContext;
 const [bu]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'LIST',label:'Fictional ordered list',name:'Fictional list unit'}).returning();
 const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional grade12',rank:12}).returning();
 const employee=await hireEmployee(ctx,{person:{fullName:'Fictional private salary recipient',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:bu.id,gradeId:grade.id,employmentType:'full_time',hiredOn:'2020-01-01'});
 await owner.db.update(s.employment).set({confirmationDate:'2020-04-01'}).where(eq(s.employment.id,employee.employmentId));
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:9876,effectiveFrom:'2020-01-01'});
 const unitId=await createApprovedRewardUnit(ctx,{name:'Fictional snapshot list',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:today});
 return {b,ctx,bu,grade,employee,unitId};
}
async function oracle(ctx:SessionContext,ids:string[],filters:RewardConfigurationFilters={}){
 return withModulePresentationRead(ctx,'rewards',async tx=>{
  const all=await legacyRewardConfigurationListTx(tx,ids);
  const units=all.filter(u=>(!filters.cycle||u.cycleId===filters.cycle)&&(!filters.company||u.companyId===filters.company)&&(!filters.unit||u.businessUnitId===filters.unit)&&(!filters.stage||u.status===filters.stage));
  const coverage=new Map((await rewardUnitCoverage(tx,units.filter(u=>!['posted','withdrawn','rejected'].includes(u.status)).map(u=>u.id))).map(c=>[c.unitId,c.missing.length]));
  return {all,units,coverage};
 });
}
async function suspended(f:Awaited<ReturnType<typeof fixture>>){
 const [person]=await owner.db.insert(s.person).values({tenantId:f.b.tenantId,fullName:'Fictional suspended reviewer',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 const userId=await createAppUser(f.b.tenantId,person.id,'employee');
 const [member]=await owner.db.insert(s.rewardMember).values({tenantId:f.b.tenantId,unitId:f.unitId,userId,role:'bg'}).returning();
 await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,userId));return member;
}
async function observations(tenantId:string){return [...await owner.client`select o.member_id,o.source_event_id,o.state_key,e.event_type,e.payload from reward_access_observation o join domain_event e on e.id=o.source_event_id where o.tenant_id=${tenantId}::uuid order by o.member_id,o.state_key`];}

async function seatedPlanLandingActor(f:Awaited<ReturnType<typeof fixture>>):Promise<SessionContext>{
 const personId=f.employee.personId,userId=await createAppUser(f.b.tenantId,personId,'employee');
 // The native observer would accept an own seat on this review. The landing still needs old configuration authority.
 await owner.db.insert(s.rewardMember).values({tenantId:f.b.tenantId,unitId:f.unitId,userId,role:'ctro'});
 return {...f.ctx,userId,personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
}

async function planLandingAuthority(ctx:SessionContext,unitId:string){
 const [row]=await database.withTenant(ctx,tx=>tx.execute<{current:boolean;setup:boolean;seat:boolean}>(sql`select
  app.principal_snapshot_current() as "current",app.reward_setup_allowed(NULL,'manage') as setup,
  'ctro' in (select app.reward_roles(${unitId}::uuid)) as seat`));
 return row;
}

it('matches the frozen full DTO and coverage, exact filters, empty and duplicate scopes under native RR/RO',async()=>{
 const f=await fixture(),due=today;
 await saveRewardCalendar(f.ctx,f.unitId,0,{...emptyRewardCalendar(),due:{...emptyRewardCalendar().due,bu:due}});
 const expected=await oracle(f.ctx,[f.b.companyId]);expect(expected.all.map(u=>u.id)).toEqual([f.unitId]);
 expect(expected.all[0]).toMatchObject({companyId:f.b.companyId,businessUnitId:f.bu.id,people:1,verified:0,seat:'bu',holders:[],due,daysUntilDue:0});
 const assertPrivateFactsAbsent=(value:unknown):void=>{
  if(Array.isArray(value)){value.forEach(assertPrivateFactsAbsent);return;}
  if(value!==null&&typeof value==='object'){
   for(const [key,item] of Object.entries(value)){expect(['basicCents','recommendation']).not.toContain(key);assertPrivateFactsAbsent(item);}return;
  }
  expect([9876,987600,'9876','9876.00','987600','Fictional private salary recipient']).not.toContain(value);
 };
 assertPrivateFactsAbsent(expected.all);
 const observed=observeNativeRead();
 try{
  const actual=await rewardConfigurationListView(f.ctx,[f.b.companyId]);expect(actual).toEqual(expected);
  expect(observed.properties).toHaveLength(2);expect(observed.properties.map(p=>[p.role,p.isolation,p.readOnly])).toEqual([['ai_hr_app','read committed',false],['ai_hr_app','repeatable read',true]]);
  expect(observed.state).toEqual({active:0,maxActive:1});
  expect(observed.queries.filter(q=>q.sql.includes('reward_access_observe'))).toHaveLength(1);
  expect(observed.queries.some(q=>/\b(insert|update|delete)\b/i.test(q.sql))).toBe(false);
 }finally{observed.restore();}
 for(const filters of [{cycle:expected.all[0].cycleId},{company:f.b.companyId},{unit:f.bu.id},{stage:'draft'},{cycle:'unknown'},{company:'unknown'},{unit:'unknown'},{stage:'unknown'},{cycle:'',company:'',unit:'',stage:''},{cycle:expected.all[0].cycleId,company:f.b.companyId,unit:f.bu.id,stage:'draft'}]){
  expect(await rewardConfigurationListView(f.ctx,[f.b.companyId],filters)).toEqual(await oracle(f.ctx,[f.b.companyId],filters));
 }
 expect(await rewardConfigurationListView(f.ctx,[f.b.companyId,f.b.companyId])).toEqual(expected);
 expect(await rewardConfigurationListView(f.ctx,[])).toEqual({all:[],units:[],coverage:new Map()});
 const [login]=await database.withTenant(f.ctx,tx=>tx.execute<{current:string;session:string;owner:boolean}>(sql`select current_user as "current",session_user as session,app.acting_as_owner() as owner`));
 expect(login).toEqual({current:'ai_hr_app',session:'ai_hr_app',owner:false});
},60000);

it('preserves retained cancellation metadata and omits coverage for terminal reviews',async()=>{
 const f=await fixture(),reason='Fictional review cancelled after organisational consolidation';
 expect((await rewardConfigurationListView(f.ctx,[f.b.companyId])).coverage.has(f.unitId)).toBe(true);
 await cancelRewardReview(f.ctx,f.unitId,1,reason);
 const value=await rewardConfigurationListView(f.ctx,[f.b.companyId]);expect(value).toEqual(await oracle(f.ctx,[f.b.companyId]));
 expect(value.all[0]).toMatchObject({status:'withdrawn',seat:null,holders:[],cancellation:{on:today,reason,by:'Fictional snapshot operator'}});
 expect(value.coverage.size).toBe(0);expect((await rewardConfigurationListView(f.ctx,[f.b.companyId],{stage:'draft'})).units).toEqual([]);
},60000);

it('commits the native suspension observation once, including empty selected IDs, and retains it after a later snapshot failure',async()=>{
 const f=await fixture(),member=await suspended(f);expect(await observations(f.b.tenantId)).toEqual([]);
 // Genuine application SQL failure after the separately committed audit; no audit result is mocked.
 const actual=database.withTenant;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof actual>[2])=>actual(ctx,async tx=>{
  if(options?.readOnlySnapshot)await tx.execute(sql`select 1/0`);return read(tx);
 },options));
 try{await expect(rewardConfigurationListView(f.ctx,[])).rejects.toMatchObject({cause:{code:'22012'}});}finally{spy.mockRestore();}
 const rows=await observations(f.b.tenantId);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({member_id:member.id,event_type:'reward-access.suspended',payload:expect.objectContaining({memberId:member.id,reason:'login'})});
 expect(await rewardConfigurationListView(f.ctx,[])).toEqual({all:[],units:[],coverage:new Map()});expect(await observations(f.b.tenantId)).toEqual(rows);
},60000);

it('propagates a native audit write refusal before opening a presentation transaction',async()=>{
 const f=await fixture();await suspended(f);const actual=database.withTenant;let snapshots=0;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof actual>[2])=>actual(ctx,async tx=>{
  if(options?.readOnlySnapshot)snapshots++;else await tx.execute(sql`set transaction read only`);return read(tx);
 },options));
 try{await expect(rewardConfigurationListView(f.ctx,[f.b.companyId])).rejects.toMatchObject({cause:{code:'25006'}});expect(snapshots).toBe(0);expect(await observations(f.b.tenantId)).toEqual([]);}finally{spy.mockRestore();}
},60000);

it('preserves the old scoped HR observation on Plans without allowing a review seat or a revoked grant',async()=>{
 const f=await fixture(),member=await suspended(f),actor=await seatedPlanLandingActor(f);
 expect(await planLandingAuthority(actor,f.unitId)).toEqual({current:true,setup:false,seat:true});
 await observeRewardPlanLandingAccess(actor);
 expect(await observations(f.b.tenantId)).toEqual([]);

 const addScopedHr=()=>owner.db.insert(s.roleAssignment).values({tenantId:f.b.tenantId,appUserId:actor.userId!,
  role:'hr_admin',companyId:f.b.companyId}).returning({id:s.roleAssignment.id});
 const [grant]=await addScopedHr();
 const hr={...actor,roles:['employee','hr_admin'],grants:[...actor.grants!,{role:'hr_admin',companyId:f.b.companyId}]};
 expect(await planLandingAuthority(hr,f.unitId)).toEqual({current:true,setup:false,seat:true});
 await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.id,grant.id));
 expect((await planLandingAuthority(hr,f.unitId)).current).toBe(false);
 expect(await planLandingAuthority(actor,f.unitId)).toEqual({current:true,setup:false,seat:true});
 await observeRewardPlanLandingAccess(hr);
 expect(await observations(f.b.tenantId)).toEqual([]);

 await addScopedHr();
 await observeRewardPlanLandingAccess(hr);
 await expect(rewardSetupPlanChoices(hr)).rejects.toMatchObject({code:'forbidden'});
 const rows=await observations(f.b.tenantId);
 expect(rows).toHaveLength(1);
 expect(rows[0]).toMatchObject({member_id:member.id,event_type:'reward-access.suspended',
  payload:expect.objectContaining({memberId:member.id,reason:'login'})});
 await observeRewardPlanLandingAccess(hr);
 expect(await observations(f.b.tenantId)).toEqual(rows);
},60000);

it('commits the Group Rewards landing observation in RC before the separate Plans snapshot',async()=>{
 const f=await fixture(),member=await suspended(f),actor=await seatedPlanLandingActor(f);
 await saveRewardGroupRole(f.ctx,{userId:actor.userId,role:'gr',active:true,revision:0,reason:'Fictional Group Rewards landing grant'});
 expect(await planLandingAuthority(actor,f.unitId)).toEqual({current:true,setup:true,seat:true});
 expect((await rewardWholeGroupSetupCompanies(actor)).map(c=>c.id)).toContain(f.b.companyId);
 const [binding]=await owner.client<{plan_version_id:string}[]>`select plan_version_id from reward_unit_setup
  where tenant_id=${f.b.tenantId}::uuid and unit_id=${f.unitId}::uuid`;
 const actual=database.withTenant;
 const readonly=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof actual>[2])=>actual(ctx,async tx=>{
  await tx.execute(sql`set transaction read only`);return read(tx);
 },options));
 try{await expect(observeRewardPlanLandingAccess(actor)).rejects.toMatchObject({cause:{code:'25006'}});}
 finally{readonly.mockRestore();}
 expect(await observations(f.b.tenantId)).toEqual([]);

 const observed=observeNativeRead();
 try{
  await observeRewardPlanLandingAccess(actor);
  const rows=await observations(f.b.tenantId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({member_id:member.id,event_type:'reward-access.suspended'});
  expect((await rewardSetupPlanChoices(actor)).map(row=>row.source.versionId)).toEqual([binding.plan_version_id]);
  expect(observed.properties.map(p=>[p.role,p.isolation,p.readOnly])).toEqual([
   ['ai_hr_app','read committed',false],['ai_hr_app','repeatable read',true],
  ]);
  expect(observed.queries.filter(q=>q.sql.includes('reward_access_observe'))).toHaveLength(1);
  expect(observed.state).toEqual({active:0,maxActive:1});
 }finally{observed.restore();}
 const reviews=await listRewardReviewStatus(actor,[f.b.companyId],{includeCreationPlan:true});
 expect(reviews.rows).toEqual(expect.arrayContaining([
  expect.objectContaining({id:f.unitId,creationPlanVersionId:binding.plan_version_id}),
 ]));
},60000);

it('keeps RC supplied-Tx admission and omitted observation while the bounded query equals the old projection',async()=>{
 const f=await fixture();await owner.withTenant(f.ctx,tx=>tx.execute(sql`insert into reward_uploaded_review(unit_id,tenant_id) values(${f.unitId}::uuid,${f.b.tenantId}::uuid)`));
 const expected=await oracle(f.ctx,[f.b.companyId]);expect(expected.all[0]).toMatchObject({uploaded:true,uploadPending:true});
 const observed=observeNativeRead();
 try{
  const actual=await database.withTenant(f.ctx,tx=>listRewardUnits(f.ctx,[f.b.companyId],tx));expect(actual).toEqual(expected.all);
  expect(observed.queries.filter(q=>q.sql.includes('reward_access_observe'))).toHaveLength(0);
  expect(observed.properties.map(p=>[p.isolation,p.readOnly])).toEqual([['read committed',false]]);
  await expect(database.withTenant(f.ctx,tx=>listRewardUnits(f.ctx,[f.b.companyId],tx),{readOnlySnapshot:true})).rejects.toThrow();
 }finally{observed.restore();}
 expect(await rewardConfigurationListView(f.ctx,[f.b.companyId])).toEqual(expected);
 expect(await rewardCoverageForUnits(f.ctx,[f.unitId])).toEqual(await withModulePresentationRead(f.ctx,'rewards',tx=>rewardUnitCoverage(tx,[f.unitId])));
 const expectedRules=await database.withTenant(f.ctx,tx=>tx.execute<{id:string;cycleId:string;cycle:string;companyId:string;company:string;year:number}>(sql`
  select u.id,c.id as "cycleId",c.name as cycle,u.company_id as "companyId",co.legal_name as company,c.year
  from reward_unit u join reward_cycle c on c.id=u.cycle_id and c.tenant_id=u.tenant_id join company co on co.id=u.company_id and co.tenant_id=u.tenant_id
  where u.id=${f.unitId}::uuid and u.tenant_id=app.current_tenant_id() and app.reward_capability(u.id,'rules.view')`));
 expect(expectedRules.map(row=>row.id)).toEqual([f.unitId]);
 expect(await rewardRulesChoices(f.ctx,[f.b.companyId])).toEqual([...expectedRules]);
},60000);

it('retains native upload pending/null distinctions across doer/checker and refresh, including View as disclosure',async()=>{
 const f=await fixture();
 const check=async(pending:boolean|undefined)=>{
  const actual=await rewardConfigurationListView(f.ctx,[f.b.companyId]);expect(actual).toEqual(await oracle(f.ctx,[f.b.companyId]));
  if(pending===undefined){expect(actual.all[0]).not.toHaveProperty('uploaded');expect(actual.all[0]).not.toHaveProperty('uploadPending');}
  else expect(actual.all[0]).toMatchObject({uploaded:true,uploadPending:pending});return actual;
 };
 await check(undefined);
 await owner.withTenant(f.ctx,tx=>tx.execute(sql`insert into reward_uploaded_review(unit_id,tenant_id) values(${f.unitId}::uuid,${f.b.tenantId}::uuid)`));await check(true);
 await owner.db.update(s.rewardEntry).set({facts:{...emptyFacts(),reviewed:true}}).where(eq(s.rewardEntry.unitId,f.unitId));
 const [person]=await owner.db.insert(s.person).values({tenantId:f.b.tenantId,fullName:'Fictional independent upload checker',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 const userId=await createAppUser(f.b.tenantId,person.id,'employee'),checker={...f.ctx,userId,personId:person.id,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
 await owner.db.insert(s.rewardMember).values({tenantId:f.b.tenantId,unitId:f.unitId,userId,role:'gr'});
 const award={employmentId:f.employee.employmentId,incrementType:'merit' as const,incrementBp:0,newBasicCents:987600,newGrade:null,bonusCents:0,lumpCents:0,remarks:'Fictional unchanged salary independently checked'};
 await saveUploadedRewards(f.ctx,f.unitId,[award],1,'Fictional original uploaded salary evidence');await check(true);
 await confirmUploadedRewards(checker,f.unitId,2,'Fictional independent checker reviewed all sources');await check(false);
 await beginRewardViewAs(f.ctx,checker.userId!);
 try{expect(await rewardConfigurationListView(f.ctx,[f.b.companyId])).toEqual(await oracle(f.ctx,[f.b.companyId]));await expect(saveUploadedRewards(f.ctx,f.unitId,[award],2,'Fictional View as must remain read only')).rejects.toThrow();}finally{await endRewardViewAs(f.ctx);}
 await refreshUploadedRewardSources(f.ctx,f.unitId,2,'Fictional source refresh retains unchanged pending semantics');await check(true);
 const [state]=await owner.client`select current_version,checked_version,refresh_required from reward_uploaded_review where unit_id=${f.unitId}::uuid`;
 expect(state).toEqual({current_version:1,checked_version:null,refresh_required:true});
},60000);

it('rechecks fresh module and native login grants and keeps foreign and seatless disclosure bounded',async()=>{
 const f=await fixture(),foreign=await seedBase();await setModule(foreign.tenantId,'rewards','active');
 expect((await rewardConfigurationListView(f.ctx,[foreign.companyId])).all).toEqual([]);
 const [person]=await owner.db.insert(s.person).values({tenantId:f.b.tenantId,fullName:'Fictional seatless operator',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 const userId=await createAppUser(f.b.tenantId,person.id,'hr_admin'),seatless={...f.ctx,userId,personId:person.id};
 const value=await rewardConfigurationListView(seatless,[f.b.companyId]);expect(value.all[0]).toMatchObject({people:null,verified:null});expect(value).toEqual(await oracle(seatless,[f.b.companyId]));
 await setModule(f.b.tenantId,'rewards','disabled');await expect(rewardConfigurationListView(f.ctx,[f.b.companyId])).rejects.toThrow();
 await setModule(f.b.tenantId,'rewards','active');expect((await rewardConfigurationListView(f.ctx,[f.b.companyId])).all.map(u=>u.id)).toEqual([f.unitId]);
 for(const ctx of [{...f.ctx,personId:randomUUID()},{...f.ctx,entitlementsExempt:'platform' as const},{...f.ctx,statutoryOverride:'Fictional refusal control'}])await expect(rewardConfigurationListView(ctx,[f.b.companyId])).rejects.toThrow();
 await owner.db.delete(s.roleAssignment).where(and(eq(s.roleAssignment.appUserId,f.ctx.userId!),eq(s.roleAssignment.tenantId,f.b.tenantId)));
 await expect(rewardConfigurationListView(f.ctx,[f.b.companyId])).rejects.toThrow();
},60000);

it('finishes an admitted presentation while real Access and AI writers remain held, then refuses the committed grant decrease',async context=>{
 const f=await fixture(),expected=await oracle(f.ctx,[f.b.companyId]);let release!:()=>void,entered!:()=>void,writer:Promise<unknown>|undefined,pid=0,held=false;
 const ready=new Promise<void>(resolve=>{entered=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});
 const abort=()=>release();context.signal.addEventListener('abort',abort,{once:true});
 const observed=observeNativeRead({after:async query=>{
  if(held||!query.sql.includes('from "reward_unit"'))return;held=true;
  // This is the presentation SELECT: the preceding observation transaction has already COMMITTED.
  writer=owner.client.begin(async tx=>{
   await tx`set local statement_timeout='20s'`;await tx`set local lock_timeout='1s'`;
   await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+f.b.tenantId},0))`;
   await tx`select pg_advisory_xact_lock(hashtext('ai-control'),hashtext(${f.b.tenantId}))`;
   const [row]=await tx`select pg_backend_pid() as pid`;pid=row.pid;
   await tx`delete from role_assignment where tenant_id=${f.b.tenantId}::uuid and app_user_id=${f.ctx.userId!}::uuid`;entered();await done;
  });
  await Promise.race([ready,writer.then(()=>{throw Error('Writer ended before native barriers');})]);context.signal.throwIfAborted();
 }});
 try{
  expect(await rewardConfigurationListView(f.ctx,[f.b.companyId])).toEqual(expected);expect(held).toBe(true);
  const [locks]=await owner.client`select
   exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and granted and objsubid=1 and classid::bigint=((hashtextextended(${'access-configuration:'+f.b.tenantId},0)>>32)&4294967295) and objid::bigint=(hashtextextended(${'access-configuration:'+f.b.tenantId},0)&4294967295)) as access,
   exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and granted and objsubid=2 and classid::bigint=(hashtext('ai-control')::bigint+4294967296)%4294967296 and objid::bigint=(hashtext(${f.b.tenantId})::bigint+4294967296)%4294967296) as ai`;
  expect(locks).toEqual({access:true,ai:true});
  expect(observed.properties.filter(p=>p.readOnly).map(p=>p.isolation)).toEqual(['repeatable read']);expect(observed.state.active).toBe(0);
 }finally{release();context.signal.removeEventListener('abort',abort);observed.restore();if(writer)await writer;}
 await expect(rewardConfigurationListView(f.ctx,[f.b.companyId])).rejects.toThrow();
},60000);

it('returns at most authorized-ID upload rows with a large genuine unrelated population and the same complete DTO/query count',async()=>{
 const f=await fixture(),count=1000;
 const [company]=await owner.db.insert(s.company).values({tenantId:f.b.tenantId,legalName:'Fictional unrelated upload company'}).returning();
 const [bu]=await owner.db.insert(s.businessUnit).values({tenantId:f.b.tenantId,companyId:company.id,code:'OTHER',name:'Fictional other unit'}).returning();
 await setupCompanyStructureFixture(f.ctx,[{companyId:company.id,businessUnitId:bu.id}],today);
 const [department]=await owner.db.insert(s.department).values({tenantId:f.b.tenantId,companyId:company.id,name:'Fictional unrelated upload department'}).returning();
 // Native policy-pair membership requires a real current employment/assignment, beyond company tags.
 const unrelated=await hireEmployee(f.ctx,{person:{fullName:'Fictional unrelated upload employee',primaryEmail:randomUUID()+'@example.invalid'},companyId:company.id,departmentId:department.id,businessUnitId:bu.id,employmentType:'full_time',hiredOn:today});
 const stored=await database.withTenant(f.ctx,tx=>tx.execute<{employmentCompanyId:string;companyId:string;businessUnitId:string|null;hiredOn:string;validFrom:string}>(sql`
  select e.company_id as "employmentCompanyId",a.company_id as "companyId",a.business_unit_id as "businessUnitId",e.hired_on::text as "hiredOn",a.valid_from::text as "validFrom"
  from employment e join assignment a on a.employment_id=e.id and a.tenant_id=e.tenant_id
  where e.id=${unrelated.employmentId}::uuid and e.tenant_id=app.current_tenant_id() and a.superseded_at is null
   and a.valid_from<=${today}::date and (a.valid_to is null or a.valid_to>${today}::date)`));
 expect([...stored]).toEqual([{employmentCompanyId:company.id,companyId:company.id,businessUnitId:bu.id,hiredOn:today,validFrom:today}]);
 // Historical fixture rows use the actual owner, bound tenant and every existing native trigger.
 await owner.withTenant(f.ctx,async tx=>{
  await tx.execute(sql`insert into reward_uploaded_review(unit_id,tenant_id) values(${f.unitId}::uuid,${f.b.tenantId}::uuid)`);
  await tx.execute(sql`with cycles as(insert into reward_cycle(tenant_id,name,year,created_by) select ${f.b.tenantId}::uuid,'Fictional retained upload '||n,${year},${f.ctx.userId!}::uuid from generate_series(1,${count}) n returning id), units as(insert into reward_unit(tenant_id,cycle_id,company_id,business_unit_id,policy,snapshot_date,created_by) select ${f.b.tenantId}::uuid,c.id,${company.id}::uuid,${bu.id}::uuid,u.policy,${today}::date,${f.ctx.userId!}::uuid from cycles c cross join reward_unit u where u.id=${f.unitId}::uuid returning id) insert into reward_uploaded_review(unit_id,tenant_id) select id,${f.b.tenantId}::uuid from units`);
 });
 const receipt:{complete:boolean;population:number;oldRows:number;newRows:number;oldStatements:number;newStatements:number;maxActive:number}={complete:false,population:count+1,oldRows:0,newRows:0,oldStatements:0,newStatements:0,maxActive:0};
 const before=observeNativeRead();let expected:Awaited<ReturnType<typeof oracle>>;
 try{expected=await oracle(f.ctx,[f.b.companyId]);receipt.oldRows=before.queries.find(q=>q.sql.includes('from reward_uploaded_review'))?.rows??-1;receipt.oldStatements=before.queries.length;}finally{before.restore();}
 const after=observeNativeRead();
 try{
  const actual=await rewardConfigurationListView(f.ctx,[f.b.companyId]);expect(actual).toEqual(expected!);
  receipt.newRows=after.queries.find(q=>q.sql.includes('from reward_uploaded_review'))?.rows??-1;receipt.newStatements=after.queries.length;receipt.maxActive=after.state.maxActive;
  expect(receipt.oldRows).toBe(count+1);expect(receipt.newRows).toBe(1);expect(receipt.newRows).toBeLessThanOrEqual(actual.all.length);
  // Facade has exactly one extra statement: its unchanged native audit prephase.
  expect(receipt.newStatements).toBe(receipt.oldStatements+1);expect(after.properties).toHaveLength(2);expect(after.state).toEqual({active:0,maxActive:1});receipt.complete=true;
 }finally{after.restore();if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'rewards-configuration-presentation-row-census.json'),JSON.stringify(receipt,null,2)+'\n');}
},90000);
