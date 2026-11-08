/** UNINSTALLED native receipt purpose. No page adoption or installed-family claim. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi,type TestContext} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import type {TransactionSql} from 'postgres';
import * as database from '../db/client';
import type {SessionContext} from '../db/client';
import {businessUnit,jobGrade,employment,roleAssignment} from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {verifyTenantChain} from '../core/audit-chain';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import {defaultPolicy} from '../packs/rewards/model';
import {rewardLibraries} from '../packs/rewards/libraries';
import {rewardPatInputs} from '../packs/rewards/pat-inputs';
import {adminCtx,closeAll,createAppUser,owner,resetDb,seedBase,setModule,setSetting} from './harness';
import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {createUninstalledRewardsAuditFamily} from './prototypes/rewards-audited-read-family';
import {rewardsAuditFixtureOwner,type RewardsAuditFixtureOwner} from './prototypes/rewards-audited-read-owner';
import {rewardAuditPrototypeOwnership} from './prototypes/rewards-audited-read-ownership';
import {rewardAuditProjectorProcess} from './prototypes/rewards-audit-projector-process';
import {rewardAuditProjectionRace} from './prototypes/rewards-audit-projection-race';
import * as baseline from './prototypes/rewards-audited-read-baseline';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
// This fixed LOGIN/DDL family owns an entire fresh hosted job cluster.
admitSingletonTest('test/rewards-audited-read-prototype.test.ts');
const realWithTenant=database.withTenant;
const ownership=rewardAuditPrototypeOwnership();
function caseIt(name:string,work:(context:TestContext)=>Promise<void>){it(name,context=>ownership.phase(context,()=>work(context)));}
let fixture:RewardsAuditFixtureOwner|undefined,family:ReturnType<typeof createUninstalledRewardsAuditFamily>|undefined;
const owned=()=>{if(!fixture||!family)throw Error('Native Rewards fixture unavailable');return{fixture,family};};
async function setup(armed=true){
 const b=await seedBase();await setModule(b.tenantId,'rewards','active');if(armed)await setSetting(b.tenantId,'audit.hash_chain_enabled',true);
 const ctx=adminCtx(b),today=todayInKualaLumpur(),year=Number(today.slice(0,4));
 const [unit]=await owner.db.insert(businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'AUDIT',name:'Fictional audited-read Business unit'}).returning();
 const [grade]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional audited-read grade',rank:12}).returning();
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional audited-read employee',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:unit.id,gradeId:grade.id,employmentType:'full_time',hiredOn:'2020-01-01'});
 await owner.db.update(employment).set({confirmationDate:'2020-04-01'}).where(eq(employment.id,hired.employmentId));
 await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:5000,effectiveFrom:'2020-01-01'});
 const review=await createApprovedRewardUnit(ctx,{name:'Fictional audited-read annual review',year,companyId:b.companyId,businessUnitId:unit.id,snapshotDate:year+'-01-01'},{...defaultPolicy(year),ranges:{'12':[300000,500000,700000]},patTarget:123450000,patActual:129000000});
 await owner.client`update public.reward_unit set status='bg'where id=${review}::uuid`;
 const [ids]=await owner.client`select salary_version_id,bonus_version_id,pat_version_id from public.reward_unit_setup where unit_id=${review}::uuid`;
 const [chain]=await owner.client`select count(*)::int as n from public.domain_event where tenant_id=${b.tenantId}::uuid and chain_seq is not null`;
 expect(chain.n>0).toBe(armed);return{b,ctx,year,unit,grade,review,ids};
}
let f:Awaited<ReturnType<typeof setup>>;
beforeAll(async()=>{fixture=await rewardsAuditFixtureOwner();family=createUninstalledRewardsAuditFamily(fixture);},300000);
beforeEach(context=>{ownership.beforeSetup();return ownership.phase(context,async()=>{await owned().fixture.reset();await resetDb();f=await setup();});},30000);
afterEach(async()=>{await ownership.drain();vi.restoreAllMocks();try{await fixture?.finishCase();}catch(error){ownership.poison(error instanceof Error?error:Error('Rewards fixture teardown refused'));throw error;}});
afterAll(async()=>{await ownership.drain();await family?.close();if(fixture)await fixture.close();else await closeAll();});
async function stamp(tx:TransactionSql,ctx:SessionContext){const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??Array.from(new Set(grants.map(g=>g.role)))).join(',')},true),set_config('app.grants',${JSON.stringify(grants)},true),set_config('app.agent_principal_id','',true)`;}
async function auditEvents(){return Array.from(await owner.client`select id,event_type,actor_id,occurred_at::text,chain_seq,payload from public.domain_event where tenant_id=${f.b.tenantId}::uuid order by sequence`);}
async function money(){return{
 libraries:Array.from(await owner.client`select v.id,v.state,v.data,v.lock_version from public.reward_library_version v where v.tenant_id=${f.b.tenantId}::uuid order by v.id`),
 pat:Array.from(await owner.client`select id,state,inputs,revision from public.reward_pat_version where tenant_id=${f.b.tenantId}::uuid order by id`),
 units:Array.from(await owner.client`select to_jsonb(u)as unit from public.reward_unit u where u.tenant_id=${f.b.tenantId}::uuid order by u.id`),
};}
async function receipts(){return Array.from(await owner.client`select * from reward_audit_private.receipt order by observed_at,id`);}
async function refusal(promise:PromiseLike<unknown>,code='42501'){const error=await Promise.resolve(promise).then(()=>null,(error:unknown)=>error);expect(error).not.toBeNull();expect(pgSqlState(error)).toBe(code);}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function held(signal:AbortSignal,kind:'access'|'history',work:(pid:number)=>Promise<void>){
 const ready=deferred(),release=deferred();let pid=0;
 const writer=owner.client.begin(async tx=>{await tx`set local lock_timeout='300ms'`;await tx`set local statement_timeout='20s'`;if(kind==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+f.b.tenantId},0))`;else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+f.b.tenantId}))`;pid=(await tx`select pg_backend_pid()as pid`)[0].pid;ready.resolve();await release.promise;});
 const abort=()=>release.resolve();signal.addEventListener('abort',abort,{once:true});
 try{await Promise.race([ready.promise,writer.then(()=>{throw Error('Writer exited before barrier admission');})]);signal.throwIfAborted();await work(pid);}finally{release.resolve();signal.removeEventListener('abort',abort);await writer;}
}
async function gone(pid:number,started:string){
 for(let i=0;i<200;i++){
  const [actual]=await owner.client`select exists(select 1 from pg_stat_activity where pid=${pid})as pid_present,exists(select 1 from pg_stat_activity where pid=${pid} and backend_start=${started}::text::timestamptz)as exact_present`;
  if(!actual.pid_present){expect(actual.exact_present).toBe(false);return;}await new Promise(resolve=>setTimeout(resolve,10));
 }throw Error('Owned projector backend still present');
}
describe('durable-before-return read and canonical projection',()=>{
 caseIt('returns full canonical nonempty DTOs with independent IDs/money/history expectations only after receipt COMMIT',async()=>{
  const oldLibraries=await baseline.rewardLibraries(f.ctx,undefined,f.year),oldPat=await baseline.rewardPatInputs(f.ctx,f.year);
  expect(await rewardLibraries(f.ctx,undefined,f.year)).toEqual(oldLibraries);expect(await rewardPatInputs(f.ctx,f.year)).toEqual(oldPat);
  const before=await auditEvents(),financial=await money(),api=owned().family;
  expect(oldLibraries).toHaveLength(2);expect(oldPat).toHaveLength(1);
  const libraries=await api.libraries(f.ctx,undefined,f.year),pat=await api.pat(f.ctx,f.year);
  expect(libraries.data).toEqual(oldLibraries);expect(pat.data).toEqual(oldPat);
  expect(libraries.data.map(row=>row.id).sort()).toEqual([f.ids.salary_version_id,f.ids.bonus_version_id].sort());
  const salary=libraries.data.find(row=>row.id===f.ids.salary_version_id)!;
  expect(salary).toMatchObject({kind:'salary',state:'confirmed',version:1,lockVersion:3,locked:true,usedBy:[{plan:'Fictional audited-read annual review',company:'Acme Sdn Bhd',year:f.year}],data:{kind:'salary',rows:expect.arrayContaining([{gradeId:f.grade.id,grade:'12',minimumCents:300000,midpointCents:500000,maximumCents:700000}])}});
  expect(pat.data[0]).toMatchObject({company:{id:f.b.companyId,name:'Acme Sdn Bhd',businessUnitId:f.unit.id,businessUnitName:f.unit.name},current:{id:f.ids.pat_version_id,revision:1,state:'confirmed',inputs:{targetCents:123450000,actualCents:129000000,forecastCents:null,targetMonthsBp:20000}},pending:null});
  expect(pat.data[0].history.map(row=>row.id)).toEqual([f.ids.pat_version_id]);
  const committed=await receipts();expect(committed.map(row=>row.id).sort()).toEqual([libraries.receipt.id,pat.receipt.id].sort());
  expect(committed.every(row=>row.actor_id===f.ctx.userId&&row.tenant_id===f.b.tenantId&&row.version===1)).toBe(true);
  expect(await auditEvents()).toEqual(before);expect(await money()).toEqual(financial);
  expect(await api.coverage(f.ctx)).toMatchObject({committedReceipts:'2',projectedReceipts:'0',pendingReceipts:'2',caughtUp:false,processor:'uninstalled',failures:null});
  expect(await api.materialize()).toBe(2);expect(await api.materialize()).toBe(0);
  const events=(await auditEvents()).filter(row=>!before.some(old=>old.id===row.id));expect(events.map(row=>row.id).sort()).toEqual(committed.map(row=>row.event_id).sort());
  expect(events.map(row=>row.event_type).sort()).toEqual(['rewards-setup.libraries.viewed','rewards-setup.pat.viewed']);
  expect((await owner.client`select count(*)::int as n from reward_audit_private.receipt r join public.domain_event e on e.id=r.event_id join reward_audit_private.projection p on p.receipt_id=r.id and p.event_id=e.id where e.actor_id=r.actor_id and e.occurred_at=r.observed_at and e.chain_seq is not null and e.hash=app.domain_event_hash(e.prev_hash,e.tenant_id,e.chain_seq,e.aggregate_type,e.aggregate_id,e.event_type,e.actor_type::text,e.actor_id,e.subject_employment_id,e.payload)`)[0].n).toBe(2);
  expect(await verifyTenantChain(f.ctx)).toMatchObject({valid:true,unchainedInsideChain:0});expect(await money()).toEqual(financial);
  expect(await api.coverage(f.ctx)).toMatchObject({pendingReceipts:'0',projectedReceipts:'2',caughtUp:true});
 });
 caseIt('records durable empty/filter reads without widening library IDs, and leaves legacy audit sequencing intact',async()=>{
  const api=owned().family,before=await auditEvents();
  expect((await api.libraries(f.ctx,'salary',f.year)).data.map(row=>row.id)).toEqual([f.ids.salary_version_id]);
  expect((await api.libraries(f.ctx,'salary',f.year+1)).data).toEqual([]);expect((await receipts()).map(row=>({kind:row.kind,year:row.year}))).toEqual([{kind:'salary',year:f.year},{kind:'salary',year:f.year+1}]);
  expect(await auditEvents()).toEqual(before);expect(await api.materialize()).toBe(2);
  const count=(await auditEvents()).length;expect(await rewardLibraries(f.ctx,'bonus',f.year)).toHaveLength(1);expect((await auditEvents()).length).toBe(count+1);expect((await auditEvents()).at(-1)?.payload).toEqual({kind:'bonus',year:f.year});
 });
 caseIt('commits exact receipts while Access and History writers remain held; old audited readers still enforce their barriers',async context=>{
  const api=owned().family,before=await auditEvents(),financial=await money();
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:database.Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>realWithTenant(ctx,async tx=>{await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);return read(tx);},options));
  try{for(const kind of ['access','history']as const)await held(context.signal,kind,async pid=>{
   expect((await api.libraries(f.ctx,'salary',f.year,context.signal)).data.map(row=>row.id)).toEqual([f.ids.salary_version_id]);expect((await api.pat(f.ctx,f.year,context.signal)).data[0].current?.inputs.actualCents).toBe(129000000);
   expect((await owner.client`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory'and granted)as held`)[0].held).toBe(true);
   await refusal(kind==='access'?rewardLibraries(f.ctx,'salary',f.year):rewardPatInputs(f.ctx,f.year),'55P03');
  });}finally{spy.mockRestore();}
  expect(await receipts()).toHaveLength(4);expect(await auditEvents()).toEqual(before);expect(await money()).toEqual(financial);
 });
 caseIt('requires native RR/RW, exact backend/transaction admission and complete receipt COMMIT; rollback discloses no service result or durable effect',async()=>{
  const reader=owned().fixture.connect('reader'),before=await auditEvents();let queried=false;
  await refusal(reader.begin(async tx=>{await stamp(tx,f.ctx);await tx`select reward_audit_read.begin_read('libraries',NULL,${f.year})`;}));
  await refusal(reader.begin('isolation level repeatable read read only',async tx=>{await stamp(tx,f.ctx);await tx`select reward_audit_read.begin_read('libraries',NULL,${f.year})`;}));
  await refusal(reader.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);await tx`select reward_audit_read.begin_read('libraries',NULL,${f.year})`;const rows=await tx`select id from public.reward_library where year=${f.year}`;queried=rows.length===2;}),'55000');
  expect(queried).toBe(true);expect(await receipts()).toEqual([]);expect(await auditEvents()).toEqual(before);
  await refusal(reader`select reward_audit_read.finalize_read(${randomUUID()}::uuid)`);
  await refusal(reader.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);await tx`select id from public.reward_library`;}));
 });
 caseIt('bounds real LOGIN grants and denies every business write, app namespace, foreign helper and cross-backend finalize',async()=>{
  const native=owned().fixture,reader=native.connect('reader'),other=native.connect('reader'),projector=native.connect('projector'),before=await money();
  expect((await reader`select session_user,current_user,has_schema_privilege(current_user,'app','USAGE')as app`)[0]).toEqual({session_user:'ai_hr_reward_audit_read',current_user:'ai_hr_reward_audit_read',app:false});
  for(const connection of [reader,projector]){
   await refusal(connection`select app.principal_snapshot_current()`);await refusal(connection`update public.reward_library_version set reason='A prototype must not write business facts'`);await refusal(connection`update public.reward_pat_version set reason='A prototype must not write business facts'`);await refusal(connection`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type)values(${f.b.tenantId}::uuid,'fixture',${randomUUID()}::uuid,'fixture.forbidden','system')`);
  }
  const entered=deferred(),release=deferred();let id='';
  const admission=reader.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);id=(await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`)[0].id;entered.resolve();await release.promise;await tx`select reward_audit_read.finalize_read(${id}::uuid)`;});
  try{await Promise.race([entered.promise,admission.then(()=>{throw Error('Owned admission exited before the controlled phase');})]);await refusal(other.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);await tx`select reward_audit_read.finalize_read(${id}::uuid)`;}));}finally{release.resolve();await admission;}
  await refusal(reader`select reward_audit_projection.materialize(1)`);await refusal(projector`select reward_audit_read.begin_read('libraries',NULL,NULL)`);expect(await money()).toEqual(before);
 });
 caseIt('honors CTRO-only library disclosure, unlinked legacy grants, company-only denial and fresh revocation with retained contexts',async()=>{
  const user=await createAppUser(f.b.tenantId,null,'employee'),ctx={...f.ctx,userId:user,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]},api=owned().family;
  const [grant]=await owner.client`insert into public.reward_setup_grant(tenant_id,user_id,company_id,role,valid_from,created_by,reason)values(${f.b.tenantId}::uuid,${user}::uuid,NULL,'ctro','2000-01-01',${f.ctx.userId!}::uuid,'Fictional CTRO-only view grant')returning id`;
  const baseline=await rewardLibraries(ctx,'salary',f.year);expect((await api.libraries(ctx,'salary',f.year)).data).toEqual(baseline);expect(baseline.map(row=>row.id)).toEqual([f.ids.salary_version_id]);await refusal(api.pat(ctx,f.year));
  await owner.client`update public.reward_setup_grant set active=false where id=${grant.id}::uuid`;const before=await receipts();await refusal(api.libraries(ctx,'salary',f.year));expect(await receipts()).toEqual(before);
  await owner.client`update public.reward_setup_grant set role='gr',active=true,company_id=${f.b.companyId}::uuid where id=${grant.id}::uuid`;await refusal(api.libraries(ctx));await refusal(api.pat(ctx,f.year));
 });
 caseIt('refuses stale actual-role, archived, forged, foreign-tenant and freshly disabled native module contexts without receipts',async()=>{
  const api=owned().family,other=await seedBase(),before=await receipts();await setModule(other.tenantId,'rewards','active');
  await expect(api.libraries({...f.ctx,tenantId:other.tenantId})).rejects.toThrow();
  await refusal(api.libraries({...adminCtx(other),userId:f.ctx.userId,roles:f.ctx.roles,grants:f.ctx.grants}));await refusal(api.libraries({...f.ctx,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]}));
  await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.ctx.userId!));await refusal(api.libraries(f.ctx));expect(await receipts()).toEqual(before);
  await owner.db.insert(roleAssignment).values({tenantId:f.b.tenantId,appUserId:f.ctx.userId!,role:'hr_admin',companyId:null});
  await owner.client`update public.app_user set archived_at=clock_timestamp()where id=${f.ctx.userId!}::uuid`;await refusal(api.libraries(f.ctx));await owner.client`update public.app_user set archived_at=NULL where id=${f.ctx.userId!}::uuid`;
  await owner.client`update public.tenant_module set status='disabled'where tenant_id=${f.b.tenantId}::uuid and module_code='rewards'`;await refusal(api.libraries(f.ctx));expect(await receipts()).toEqual(before);
  await owner.client`update public.tenant_module set status='active'where tenant_id=${f.b.tenantId}::uuid and module_code='rewards'`;await owner.client`update public.tenant set status='suspended'where id=${f.b.tenantId}::uuid`;await refusal(api.libraries(f.ctx));expect(await receipts()).toEqual(before);
 });
 caseIt('refuses unarmed tenants explicitly while retaining their original audited reader behavior',async()=>{
  const unarmed=await setup(false),api=owned().family;expect(await rewardLibraries(unarmed.ctx,'salary',unarmed.year)).toHaveLength(1);const before=await receipts();await refusal(api.libraries(unarmed.ctx,'salary',unarmed.year));expect(await receipts()).toEqual(before);
  expect((await owner.client`select count(*)::int as n from public.domain_event where tenant_id=${unarmed.b.tenantId}::uuid and chain_seq is not null`)[0].n).toBe(0);
 });
 caseIt('discovers later receipt commits behind already projected work and preserves observation time versus append order',async()=>{
  const reader=owned().fixture.connect('reader'),api=owned().family,entered=deferred(),release=deferred();let late='';
  const pending=reader.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);late=(await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`)[0].id;expect(await tx`select id from public.reward_library where kind='salary'and year=${f.year}`).toHaveLength(1);await tx`select reward_audit_read.finalize_read(${late}::uuid)`;entered.resolve();await release.promise;});
  let early='';try{await Promise.race([entered.promise,pending.then(()=>{throw Error('Owned late receipt exited before the controlled phase');})]);early=(await api.libraries(f.ctx,'bonus',f.year)).receipt.id;expect(await api.materialize()).toBe(1);expect((await receipts()).map(row=>row.id)).toEqual([early]);}finally{release.resolve();await pending;}
  expect(await api.materialize()).toBe(1);expect(await api.materialize()).toBe(0);
  expect((await owner.client`select l.observed_at<e.observed_at as observed_before,le.chain_seq>ee.chain_seq as appended_after from reward_audit_private.receipt l join public.domain_event le on le.id=l.event_id cross join reward_audit_private.receipt e join public.domain_event ee on ee.id=e.event_id where l.id=${late}::uuid and e.id=${early}::uuid`)[0]).toEqual({observed_before:true,appended_after:true});
  expect(await verifyTenantChain(f.ctx)).toMatchObject({valid:true,unchainedInsideChain:0});
 });
 caseIt('materializes historical committed intent after the actor loses access, without authorizing any new read',async()=>{
  const api=owned().family,result=await api.libraries(f.ctx,'salary',f.year),before=await money(),auditor=await createAppUser(f.b.tenantId,null,'hr_admin');
  await owner.client`update public.app_user set archived_at=clock_timestamp()where id=${f.ctx.userId!}::uuid`;await refusal(api.libraries(f.ctx));expect(await api.materialize()).toBe(1);
  expect((await owner.client`select e.actor_id=r.actor_id as original_actor,e.occurred_at=r.observed_at as original_time,e.id=r.event_id as exact_event from reward_audit_private.receipt r join public.domain_event e on e.id=r.event_id where r.id=${result.receipt.id}::uuid`)[0]).toEqual({original_actor:true,original_time:true,exact_event:true});
  expect(await verifyTenantChain({...f.ctx,userId:auditor,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]})).toMatchObject({valid:true,unchainedInsideChain:0});expect(await money()).toEqual(before);
 });
 caseIt('concurrent actual projector connections append each committed receipt exactly once with no financial effects',async()=>{
  const api=owned().family,before=await money();for(let i=0;i<4;i++)await api.libraries(f.ctx,'salary',f.year);
  expect(await Promise.all([api.materialize(2),api.materialize(2)])).toEqual([2,2]);expect(await api.materialize()).toBe(0);
  expect((await owner.client`select count(*)::int as n,count(distinct p.event_id)::int as events from reward_audit_private.projection p join reward_audit_private.receipt r on r.id=p.receipt_id join public.domain_event e on e.id=p.event_id and e.id=r.event_id`)[0]).toEqual({n:4,events:4});expect(await money()).toEqual(before);expect(await verifyTenantChain(f.ctx)).toMatchObject({valid:true,unchainedInsideChain:0});
 });
 caseIt('rechecks a committed link after an old cursor snapshot acquires the unchanged receipt tuple',async context=>{
  const api=owned().family,financial=await money();
  try{
   for(const variant of ['frozen9e','fixed']as const){
    const result=await api.libraries(f.ctx,'salary',f.year);
    await rewardAuditProjectionRace(owned().fixture,result.receipt.id,variant,context.signal);
    expect(await api.materialize()).toBe(0);expect(await money()).toEqual(financial);
    expect(await verifyTenantChain(f.ctx)).toMatchObject({valid:true,unchainedInsideChain:0});
   }
  }catch(error){ownership.poison(Error('Native projection race proof/restoration refused',{cause:error}));throw error;}
 });
 caseIt('checks only real sequence OIDs while retaining nonsequence and TOAST rejection and fresh USAGE refusal',async()=>{
  const api=owned().family,reader=owned().fixture.connect('reader'),financial=await money();
  expect((await owner.client`select to_regclass('public.reward_audit_sequence_relation')as relation,to_regclass('public.reward_audit_sequence_canary')as sequence`)[0]).toEqual({relation:null,sequence:null});
  await owner.client`create table public.reward_audit_sequence_relation(content text)`;
  await owner.client`insert into public.reward_audit_sequence_relation select string_agg(md5(n::text),'')from generate_series(1,4096)n`;
  const [relation]=await owner.client`select to_jsonb(c)as details,c.oid,c.relkind,c.reltoastrelid as toast_oid,t.relkind as toast_kind from pg_class c join pg_class t on t.oid=c.reltoastrelid where c.oid='public.reward_audit_sequence_relation'::regclass`;
  expect(relation).toMatchObject({relkind:'r',toast_kind:'t'});expect(relation.toast_oid).toBeTruthy();
  try{
   await refusal(reader`select has_sequence_privilege(current_user,${relation.oid}::oid,'USAGE')`,'42809');
   await refusal(reader`select has_sequence_privilege(current_user,${relation.toast_oid}::oid,'USAGE')`,'42809');
   await owner.client`select reward_audit_private.assert_profile()`;
  }finally{expect((await owner.client`select to_jsonb(c)as details from pg_class c where c.oid='public.reward_audit_sequence_relation'::regclass`)[0].details).toEqual(relation.details);await owner.client`drop table public.reward_audit_sequence_relation`;}
  await owner.client`create sequence public.reward_audit_sequence_canary`;
  const [sequence]=await owner.client`select to_jsonb(c)-'relacl'as details from pg_class c where c.oid='public.reward_audit_sequence_canary'::regclass`;
  try{
   await owner.client`select reward_audit_private.assert_profile()`;
   await owner.client`grant usage on sequence public.reward_audit_sequence_canary to ai_hr_reward_audit_read`;await refusal(api.libraries(f.ctx),'55000');
   await owner.client`revoke usage on sequence public.reward_audit_sequence_canary from ai_hr_reward_audit_read`;await owner.client`select reward_audit_private.assert_profile()`;
   await owner.client`grant usage on sequence public.reward_audit_sequence_canary to ai_hr_reward_audit_projector`;await refusal(api.materialize(),'55000');
   await owner.client`revoke usage on sequence public.reward_audit_sequence_canary from ai_hr_reward_audit_projector`;await owner.client`select reward_audit_private.assert_profile()`;
  }finally{
   await owner.client`revoke all on sequence public.reward_audit_sequence_canary from ai_hr_reward_audit_read,ai_hr_reward_audit_projector`;
   expect((await owner.client`select to_jsonb(c)-'relacl'as details from pg_class c where c.oid='public.reward_audit_sequence_canary'::regclass`)[0]).toEqual(sequence);await owner.client`drop sequence public.reward_audit_sequence_canary`;
  }
  expect(await receipts()).toEqual([]);expect(await money()).toEqual(financial);expect((await api.libraries(f.ctx,'salary',f.year)).data.map(row=>row.id)).toEqual([f.ids.salary_version_id]);
 });
 for(const phase of ['before','after']as const)caseIt(`SIGKILL ${phase} native projection COMMIT preserves durable pending intent and exact-once canonical audit`,async context=>{
  const api=owned().family,result=await api.libraries(f.ctx,'salary',f.year),financial=await money(),process=await rewardAuditProjectorProcess(owned().fixture,context.signal);let pid=0,start='';
  try{
   if(phase==='before')await held(context.signal,'history',async writer=>{
    const [lock]=await owner.client`select database,classid,objid,objsubid from pg_locks where pid=${writer} and locktype='advisory'and granted`;expect(lock).toBeTruthy();process.start(false);
    for(let attempt=0;attempt<1000;attempt++){
     context.signal.throwIfAborted();
     const rows=await owner.client`select a.pid,a.backend_start::text as started from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.usename='ai_hr_reward_audit_projector'and a.query like '%reward_audit_projection.materialize%'and l.locktype='advisory'and not l.granted and l.database=${lock.database}::oid and l.classid=${lock.classid}::oid and l.objid=${lock.objid}::oid and l.objsubid=${lock.objsubid}::smallint`;
     expect(rows.length).toBeLessThanOrEqual(1);if(rows.length){pid=rows[0].pid;start=rows[0].started;break;}await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(pid).toBeGreaterThan(0);process.child.kill('SIGKILL');expect(await process.closed).toEqual({code:null,signal:'SIGKILL'});await gone(pid,start);
   });
   else{
    process.start(true);const committed=await process.wait('committed');expect(committed.projected).toBe(1);expect(typeof committed.pid).toBe('number');expect(typeof committed.started).toBe('string');
    if(typeof committed.pid!=='number'||typeof committed.started!=='string')throw Error('Exact child backend identity missing');pid=committed.pid;start=committed.started;
    expect((await owner.client`select pid,usename,backend_start=${start}::text::timestamptz as exact_start from pg_stat_activity where pid=${pid}`)[0]).toEqual({pid,usename:'ai_hr_reward_audit_projector',exact_start:true});
    process.child.kill('SIGKILL');expect(await process.closed).toEqual({code:null,signal:'SIGKILL'});await gone(pid,start);
   }
   const [record]=await owner.client`select r.id,(select count(*)::int from reward_audit_private.projection p where p.receipt_id=r.id)as projections,(select count(*)::int from public.domain_event e where e.id=r.event_id)as events from reward_audit_private.receipt r where r.id=${result.receipt.id}::uuid`;
   expect(record).toEqual({id:result.receipt.id,projections:phase==='before'?0:1,events:phase==='before'?0:1});expect(await api.coverage(f.ctx)).toMatchObject({pendingReceipts:phase==='before'?'1':'0',caughtUp:phase==='after'});
   expect(await api.materialize(1)).toBe(phase==='before'?1:0);expect(await api.materialize(1)).toBe(0);expect(await money()).toEqual(financial);expect(await verifyTenantChain(f.ctx)).toMatchObject({valid:true,unchainedInsideChain:0});
  }finally{await process.stop();}
 });
 caseIt('refuses native function/ACL/trigger drift and keeps receipts immutable and business data unchanged',async()=>{
  const api=owned().family,reader=owned().fixture.connect('reader'),result=await api.libraries(f.ctx,'salary',f.year),before=await money();
  await refusal(reader`update reward_audit_private.receipt set year=2001`);await refusal(reader`delete from reward_audit_private.receipt`);
  await owner.client`alter function reward_audit_projection.materialize(integer)cost 101`;try{await refusal(api.materialize(),'55000');}finally{await owner.client`alter function reward_audit_projection.materialize(integer)cost 100`;}
  await owner.client`grant select on public.person to ai_hr_reward_audit_read`;try{await refusal(api.libraries(f.ctx),'55000');}finally{await owner.client`revoke select on public.person from ai_hr_reward_audit_read`;}
  expect((await owner.client`select to_regclass('public.reward_audit_privilege_canary')as id`)[0].id).toBeNull();await owner.client`create table public.reward_audit_privilege_canary(secret text)`;
  const [canary]=await owner.client`select c.oid,to_jsonb(c)as relation,(select jsonb_agg(to_jsonb(a)-'attacl'order by attnum)from pg_attribute a where a.attrelid=c.oid and a.attnum>0)as columns from pg_class c where c.oid='public.reward_audit_privilege_canary'::regclass`;
  try{await owner.client`grant select(secret)on public.reward_audit_privilege_canary to ai_hr_reward_audit_read`;await refusal(api.libraries(f.ctx),'55000');}
  finally{
   await owner.client`revoke select(secret)on public.reward_audit_privilege_canary from ai_hr_reward_audit_read`;
   expect((await owner.client`select c.oid,to_jsonb(c)as relation,(select jsonb_agg(to_jsonb(a)-'attacl'order by attnum)from pg_attribute a where a.attrelid=c.oid and a.attnum>0)as columns from pg_class c where c.oid='public.reward_audit_privilege_canary'::regclass`)[0]).toEqual(canary);
   expect((await owner.client`select count(*)::int as n from pg_attribute a cross join lateral unnest(a.attacl)g where a.attrelid='public.reward_audit_privilege_canary'::regclass`)[0].n).toBe(0);await owner.client`drop table public.reward_audit_privilege_canary`;
  }
  await owner.client`alter table public.domain_event disable trigger domain_event_chain_tg`;try{await refusal(api.materialize(),'55000');}finally{await owner.client`alter table public.domain_event enable trigger domain_event_chain_tg`;}
  expect((await receipts()).map(row=>row.id)).toEqual([result.receipt.id]);expect(await api.materialize()).toBe(1);expect(await money()).toEqual(before);
 });
});
