/** Compiled native cases, intentionally not a standalone selector on the old315 base.
 * Root convergence must add a thin real admitSingletonTest entrypoint BEFORE calling
 * registration. This module cannot create CI evidence, grants or release authority. */
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {afterAll,afterEach,beforeEach,expect,it,vi,type TestContext} from 'vitest';
import {sql,eq} from 'drizzle-orm';
import type {TransactionSql} from 'postgres';
import * as database from '../../db/client';
import type {SessionContext} from '../../db/client';
import {employment,businessUnit,jobGrade} from '../../db/schema';
import {hireEmployee} from '../../core/org';
import {setCompensation} from '../../core/comp';
import {verifyTenantChain} from '../../core/audit-chain';
import {grantAssistant} from '../../core/assistant-grant';
import {requirePackFor} from '../../localization/registry';
import {bankMaintenanceReviews} from '../../core/assistant-actions/bank-maintenance-review-store';
import {BankMaintenance as Bank} from '../../lib/assistant-actions/bank-maintenance-contract';
import {positionArchiveReviews} from '../../core/assistant-actions/position-archive-review-store';
import * as adminOwner from '../../core/admin';
import * as nativeErrorOwner from '../../lib/db-error';
import {defaultPolicy} from '../../packs/rewards/model';
import {rewardLibraries} from '../../packs/rewards/libraries';
import {rewardPatInputs} from '../../packs/rewards/pat-inputs';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {pgSqlState} from '../../lib/db-error';
import {owner as harnessOwner} from '../harness';
import {adminCtx,closeAll,resetDb,seedBase,setModule,setSetting,createAppUser} from '../harness';
import {createApprovedRewardUnit} from '../rewards-setup-fixture';
import {createUninstalledRewardsAuditFamily} from './rewards-audited-read-family';
import {rewardsAuditPolicyController} from './rewards-audit-policy-controller';
import {rewardsAuditPolicyFixtureOwner,type RewardsAuditPolicyFixtureOwner} from './rewards-audit-policy-owner';
import {rewardsAuditCanonicalTruthContract} from './rewards-audit-policy-contract';
import {rewardPolicyReaderProcess} from './rewards-audit-policy-reader-process';

export const rewardsAuditPolicyNativeCaseNames=[
 'constructs one real bounded injected owner with exact full native PRE/profile and generated canonical truth',
 'preserves nonempty financial DTOs and native unarmed/armed receipt projection without changing money or IDs',
 'resolves all12 canonical decisions from actual native setting/history and protected fixture fallback inputs',
 'commits the first armed floor before return and protects a fresh other-worker append after the platform setting flipsfalse',
 'rollback removes both finalized receipt and policy observation while the actual service returns no data',
 'multiple canonical appends retain fresh head/hash while parent and savepoint floor observations remain properly owned',
 'a private frame cannot be forged through app GUCs/temp tables or direct app/reader/projector APIs',
 'native cleanup sees only committed prior frames, retains active root custody and recovers stale backend metadata without killing a backend',
 'an unavailable dedicated reader refuses Rewards admission while independent canonical writers retain the committed armed floor',
 'an old RR write snapshot refuses an invisible committed floor with actual40001 while a fresh RR writer chains',
 'rolling back a first frame inside a savepoint permits a genuine later floor observation under the same root',
 'only the durable floor bit is stable while current GUC/setting/history/head remain freshly canonical',
 'RR and serializable absent-floor probes roll back even under immediate constraints without creating a durable marker',
 'native immediate constraints and COMMIT refuse incomplete markers while a genuine armed receipt retains immutable first provenance',
 'two real RR writers serialize on actual History and each rolled-back absent probe leaves no durable marker',
 'a genuine first receipt waits for the actual transient probe and commits atomically after its rollback without changing the earlier false frame',
 'a fresh-floor OR counterexample causes actual Bank PRE refusal and rolls back all native bank and financial effects',
 'a transaction-owned false floor frame preserves the actual Bank PRE and effect while a genuine armed receipt commits concurrently',
 'a fresh-floor OR counterexample causes actual Catalogue PRE42501 and rolls back the real archive owner',
 'the transaction-owned false floor frame preserves actual Catalogue archive custody while a genuine armed receipt commits concurrently',
 'SIGKILL before actual receipt COMMIT rolls back the floor and a fresh process reconciles absence without returning or replaying HR data',
 'SIGKILL after actual receipt COMMIT preserves the floor and a fresh process reconciles the exact own pending receipt',
 'new policy admission and exact receipt reconciliation retain actual stale archived forged foreign module and tenant denial without new effects',
 'native CTRO-only unlinked library disclosure retains exact current grants and company-only denial under the policy extension',
]as const;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function stamp(tx:TransactionSql,ctx:SessionContext){const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??Array.from(new Set(grants.map(g=>g.role)))).join(',')},true),set_config('app.grants',${JSON.stringify(grants)},true),set_config('app.agent_principal_id','',true),set_config('app.audit_hash_chain','off',true)`;}
async function refusal(work:PromiseLike<unknown>,code='42501'){const error=await Promise.resolve(work).then(()=>undefined,(error:unknown)=>error);expect(error).toBeDefined();expect(pgSqlState(error)).toBe(code);return error;}
export function registerRewardsAuditPolicyNativeCases(){
 const controller=rewardsAuditPolicyController(),ownership=controller.lifetime,realWithTenant=database.withTenant;
 let fixture:RewardsAuditPolicyFixtureOwner|undefined,family:ReturnType<typeof createUninstalledRewardsAuditFamily>|undefined;const caseSockets=new Set<ReturnType<typeof postgres>>();
 const owned=()=>{if(!fixture||!family)throw Error('Owned native policy constructor unavailable');return{fixture,family};};
 controller.registerStop(closeAll);
 beforeEach(()=>{ownership.beforeCase();vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED','false');vi.stubEnv('AI_CONFIG_SECRET','fictional-policy-custody-secret-123456789');});
 afterEach(async()=>{await ownership.drain();await Promise.all([...caseSockets].map(connection=>connection.end({timeout:0})));caseSockets.clear();await fixture?.finishCase();vi.restoreAllMocks();vi.unstubAllEnvs();});
 afterAll(async()=>{await ownership.drain();await controller.close(fixture!==undefined,async()=>{if(!fixture)throw Error('Unknown policy ownership');await fixture.close();});});
 const owner=controller.owner;
 async function backend(connection:ReturnType<typeof postgres>){const [row]=await connection`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started`;if(!row||typeof row.pid!=='number'||typeof row.started!=='string')throw Error('Actual native session identity required');return{pid:row.pid,started:row.started};}
 async function blocking(context:TestContext,waiting:{pid:number;started:string},holder:{pid:number;started:string}){
  const until=Date.now()+200;
  do{context.signal.throwIfAborted();const [row]=await owner.client`select exists(select 1 from pg_stat_activity w,pg_stat_activity h where w.pid=${waiting.pid} and w.backend_start=${waiting.started}::text::timestamptz and h.pid=${holder.pid} and h.backend_start=${holder.started}::text::timestamptz and h.pid=any(pg_blocking_pids(w.pid)))as owned`;
   if(row.owned===true)return;await new Promise<void>(resolve=>setTimeout(resolve,5));
  }while(Date.now()<until);
  throw Error('Actual bounded native blocking witness unavailable');
 }

 function nativeIt(index:number,work:(ctx:TestContext)=>Promise<void>){it(rewardsAuditPolicyNativeCaseNames[index],context=>ownership.run(context,async()=>{
  // Only budget instrumentation: every real application Tx and canonical service
  // still executes. No native permission, source, approval or result is mocked.
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,run:(tx:database.Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>realWithTenant(ctx,async tx=>{
   await tx.execute(sql`set local statement_timeout='20s'`);await tx.execute(sql`set local lock_timeout='300ms'`);return run(tx);
  },options));
  try{await work(context);}finally{spy.mockRestore();}
 }));}
 async function base(){await owned().fixture.finishCase();await owned().fixture.reset();await resetDb();const b=await seedBase();for(const module of ['rewards','assistant','payroll','country-my'])await setModule(b.tenantId,module,'active');await setSetting(b.tenantId,'audit.hash_chain_enabled',false);const ctx=adminCtx(b);await grantAssistant(ctx,{appUserId:b.adminUserId});return{b,ctx};}
 async function setup(){
  const f=await base(),year=Number(todayInKualaLumpur().slice(0,4));
  const [unitLabel]=await harnessOwner.db.insert(businessUnit).values({tenantId:f.b.tenantId,companyId:f.b.companyId,code:'FLOOR',name:'Fictional policy Business unit'}).returning();
  const [grade]=await harnessOwner.db.insert(jobGrade).values({tenantId:f.b.tenantId,code:'12',name:'Fictional policy grade',rank:12}).returning();
  const person=await hireEmployee(f.ctx,{person:{fullName:'Fictional native policy employee',primaryEmail:randomUUID()+'@example.invalid'},companyId:f.b.companyId,departmentId:f.b.deptA,businessUnitId:unitLabel.id,gradeId:grade.id,employmentType:'full_time',hiredOn:'2020-01-01'});
  await harnessOwner.db.update(employment).set({confirmationDate:'2020-04-01'}).where(eq(employment.id,person.employmentId));await setCompensation(f.ctx,{employmentId:person.employmentId,basicSalary:5000,effectiveFrom:'2020-01-01'});
  const unit=await createApprovedRewardUnit(f.ctx,{name:'Fictional policy annual review',year,companyId:f.b.companyId,businessUnitId:unitLabel.id,snapshotDate:year+'-01-01'},{...defaultPolicy(year),ranges:{'12':[300000,500000,700000]},patTarget:123450000,patActual:129000000});
  const [ids]=await owner.client`select salary_version_id,bonus_version_id,pat_version_id from public.reward_unit_setup where unit_id=${unit}::uuid`;
  expect((await owner.client`select count(*)::int as n from public.domain_event where tenant_id=${f.b.tenantId}::uuid and chain_seq is not null`)[0].n).toBe(0);
  const [actor]=await owner.client`select person_id from public.app_user where id=${f.ctx.userId!}::uuid`;if(!actor||typeof actor.person_id!=='string')throw Error('Actual setup actor link required');
  return{...f,ctx:{...f.ctx,personId:actor.person_id},year,person,unit,unitLabel,grade,ids};
 }
 function reader(){const connection=owned().fixture.connect('reader');caseSockets.add(connection);controller.registerStop(()=>connection.end({timeout:0}));return connection;}
 function app(){const raw=process.env.TEST_DATABASE_URL;if(!raw)throw Error('Actual canonical app URL required');const url=new URL(raw);if(url.username!=='ai_hr_app'||url.hostname!=='127.0.0.1'||url.pathname!=='/'+controller.database||url.search||url.hash)throw Error('Exact other-worker application LOGIN required');const connection=postgres(raw,{max:1,connect_timeout:2,connection:{statement_timeout:20000,lock_timeout:300}});caseSockets.add(connection);controller.registerStop(()=>connection.end({timeout:0}));return connection;}
 async function event(connection:ReturnType<typeof postgres>,ctx:SessionContext,name:string){return connection.begin(async tx=>{await stamp(tx,ctx);const [row]=await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)values(${ctx.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,${name},'user',${ctx.userId!}::uuid,'{}')returning id,chain_seq::int as chain_seq,prev_hash,hash`;return row;});}
 async function money(tenant:string){return(await owner.client`select jsonb_build_object('comp',(select jsonb_agg(to_jsonb(c)order by c.id)from public.compensation c where c.tenant_id=${tenant}::uuid),'libraries',(select jsonb_agg(to_jsonb(v)order by v.id)from public.reward_library_version v where v.tenant_id=${tenant}::uuid),'pat',(select jsonb_agg(to_jsonb(p)order by p.id)from public.reward_pat_version p where p.tenant_id=${tenant}::uuid),'units',(select jsonb_agg(to_jsonb(u)order by u.id)from public.reward_unit u where u.tenant_id=${tenant}::uuid))as value`)[0].value;}
 nativeIt(0,async()=>{
  try{fixture=await rewardsAuditPolicyFixtureOwner(controller.dependencies,ownership.poison);family=createUninstalledRewardsAuditFamily({...fixture,connectTimeoutSeconds:2});controller.registerStop(()=>owned().family.close());controller.registerStop(()=>owned().fixture.finishCase());}
  catch(error){ownership.poison(error instanceof Error?error:Error('Unknown constructor completion'));throw error;}
  expect((await owner.client`select reward_audit_policy_private.assert_profile()is null as validated,current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock`)[0]).toMatchObject({statement:'20s',lock:'300ms'});
  expect(Array.from(await owner.client`select * from reward_audit_policy_private.truth order by setting_code,has_history,env_armed`)).toEqual(rewardsAuditCanonicalTruthContract());
  expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.function_contract where signature::text like 'app.%'`)[0].n).toBe(11);
 });
 nativeIt(1,async()=>{
  const f=await setup(),api=owned().family,old=await rewardLibraries(f.ctx,undefined,f.year),oldPat=await rewardPatInputs(f.ctx,f.year),financial=await money(f.b.tenantId);
  expect(old).toHaveLength(2);expect(oldPat).toHaveLength(1);expect(old.map(row=>row.id).sort()).toEqual([f.ids.salary_version_id,f.ids.bonus_version_id].sort());
  expect(old.find(row=>row.kind==='salary')).toMatchObject({kind:'salary',state:'confirmed',data:{kind:'salary',rows:expect.arrayContaining([{gradeId:f.grade.id,grade:'12',minimumCents:300000,midpointCents:500000,maximumCents:700000}])}});
  expect(oldPat[0]).toMatchObject({company:{id:f.b.companyId,businessUnitId:f.unitLabel.id},current:{id:f.ids.pat_version_id,inputs:{targetCents:123450000,actualCents:129000000}}});
  expect((await owner.client`select basic_salary=5000::numeric as salary,currency='MYR'as currency from public.compensation where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.person.employmentId}::uuid`)[0]).toEqual({salary:true,currency:true});
  const libraries=await api.libraries(f.ctx,undefined,f.year),pat=await api.pat(f.ctx,f.year);expect(libraries.data).toEqual(old);expect(pat.data).toEqual(oldPat);
  expect((await owner.client`select bool_and(not armed)as unarmed,count(*)::int as n from reward_audit_policy_private.observation`)[0]).toEqual({unarmed:true,n:2});expect(await api.materialize()).toBe(2);
  expect((await owner.client`select count(*)::int as n from public.domain_event e join reward_audit_private.receipt r on r.event_id=e.id where e.chain_seq is null and e.hash is null and e.prev_hash is null`)[0].n).toBe(2);
  await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);expect((await api.libraries(f.ctx,'salary',f.year)).data.map(row=>row.id)).toEqual([f.ids.salary_version_id]);expect(await api.materialize()).toBe(1);expect(await api.materialize()).toBe(0);
  expect(await verifyTenantChain(f.ctx)).toMatchObject({valid:true,checked:1,unchainedInsideChain:0});expect(await money(f.b.tenantId)).toEqual(financial);
 });
 nativeIt(2,async()=>{
  await base();for(const expected of rewardsAuditCanonicalTruthContract()){
   const b=await seedBase();await setModule(b.tenantId,'rewards','active');
   if(expected.setting_code===-1)await owner.client`delete from public.tenant_setting where tenant_id=${b.tenantId}::uuid and key='audit.hash_chain_enabled'`;else await setSetting(b.tenantId,'audit.hash_chain_enabled',expected.setting_code===1);
   if(expected.has_history)await owner.client.begin(async tx=>{await tx`select set_config('app.audit_hash_chain','on',true)`;await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type)values(${b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.history','system')`;});
   await owned().fixture.protectedFixtureFallback(expected.env_armed);const [row]=await owner.client`select reward_audit_policy_private.policy(${b.tenantId}::uuid)as value`;
   expect(row.value).toMatchObject({version:1,settingCode:expected.setting_code,hasHistory:expected.has_history,envArmed:expected.env_armed,durableFloor:false,armed:expected.armed,refusedDisarm:expected.refused_disarm,reason:expected.reason});
  }
 });
 nativeIt(3,async context=>{
  const f=await setup(),api=owned().family;await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);const read=await api.libraries(f.ctx,'salary',f.year,context.signal);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
  const independent=app();expect((await independent`select session_user,current_user,current_setting('transaction_isolation')as mode`)[0]).toEqual({session_user:'ai_hr_app',current_user:'ai_hr_app',mode:'read committed'});
  const native=await event(independent,f.ctx,'policy.first-fresh-writer');expect(native.chain_seq).toBe(1);expect(native.prev_hash).toBe('GENESIS');
  expect((await owner.client`select count(*)::int as n from reward_audit_private.projection`)[0].n).toBe(0);expect(await api.materialize()).toBe(1);expect(await api.materialize()).toBe(0);
  expect((await owner.client`select e.actor_id=r.actor_id as historical_actor,e.occurred_at=r.observed_at as historical_time,e.chain_seq::int as seq,e.prev_hash=${native.hash}as linked,e.hash=app.domain_event_hash(e.prev_hash,e.tenant_id,e.chain_seq,e.aggregate_type,e.aggregate_id,e.event_type,e.actor_type::text,e.actor_id,e.subject_employment_id,e.payload)as canonical from public.domain_event e join reward_audit_private.receipt r on r.event_id=e.id where r.id=${read.receipt.id}::uuid`)[0]).toEqual({historical_actor:true,historical_time:true,seq:2,linked:true,canonical:true});
 });
 nativeIt(4,async()=>{
  const f=await setup();await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);const connection=reader(),rolledBack=Error('Controlled actual rollback after native finalization');
  await expect(connection.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);const [row]=await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`;await tx`select * from reward_audit_read.finalize_read(${row.id}::uuid)`;throw rolledBack;})).rejects.toBe(rolledBack);
  expect(await owner.client`select id from reward_audit_private.receipt`).toHaveLength(0);expect(await owner.client`select id from reward_audit_policy_private.observation`).toHaveLength(0);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);expect((await event(app(),f.ctx,'policy.after-rollback')).chain_seq).toBeNull();
 });
 nativeIt(5,async()=>{
  const f=await setup();await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);await owned().family.libraries(f.ctx,'salary',f.year);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
  await owner.client.begin(async tx=>{
   const [first]=await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`;expect(first.value).toEqual({armed:true,priorSeq:null,priorHash:null});
   await tx`savepoint policy_nested`;await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`;await tx`rollback to savepoint policy_nested`;await tx`release savepoint policy_nested`;
   await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.multiple1','system')`;
   const [second]=await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`;expect(second.value).toMatchObject({armed:true,priorSeq:1});
   await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.multiple2','system')`;
   expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`)[0].value).toMatchObject({armed:true,priorSeq:2});
   expect((await tx`select count(*)::int as n from reward_audit_policy_private.floor_frame where tenant_id=${f.b.tenantId}::uuid and root_xid=pg_current_xact_id()`)[0].n).toBe(1);
  });
 });
 nativeIt(6,async()=>{
  const f=await setup(),connection=app();
  const row=await connection.begin(async tx=>{await stamp(tx,f.ctx);await tx`create temporary table floor_frame(tenant_id uuid,observed_floor boolean)on commit drop`;await tx`insert into floor_frame values(${f.b.tenantId}::uuid,true)`;await tx`select set_config('app.reward_armed_floor','on',true)`;
   const [actual]=await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.no-spoof','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`;return actual;});expect(row.seq).toBeNull();
  const projector=owned().fixture.connect('projector');caseSockets.add(projector);controller.registerStop(()=>projector.end({timeout:0}));
  for(const actor of [connection,reader(),projector]){
   await refusal(actor`select reward_audit_policy_private.durable_floor(${f.b.tenantId}::uuid)`);await refusal(actor`select reward_audit_policy_private.floor_for_xact(${f.b.tenantId}::uuid)`);await refusal(actor`select reward_audit_policy_private.cleanup_frames(1)`);
   await refusal(actor`select * from reward_audit_policy_private.floor_frame`);await refusal(actor`update reward_audit_policy_private.floor_frame set observed_floor=true`);await refusal(actor`delete from reward_audit_policy_private.floor_frame`);
  }
  const before=(await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame`)[0].n;
  await refusal(owner.client.begin(async tx=>{await tx`select app._domain_event_next(${f.b.tenantId}::uuid)`;await tx`update reward_audit_policy_private.floor_frame set backend_pid=backend_pid+100000 where root_xid=pg_current_xact_id()and tenant_id=${f.b.tenantId}::uuid`;await tx`select app._domain_event_next(${f.b.tenantId}::uuid)`;}));
  expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame`)[0].n).toBe(before);
 });
 nativeIt(7,async context=>{
  const f=await setup(),connection=app(),ready=deferred(),release=deferred();let xid='';const backend:{value?:{pid:number;started:string}}={};const abort=()=>release.resolve();context.signal.addEventListener('abort',abort,{once:true});
  const pending=connection.begin(async tx=>{await stamp(tx,f.ctx);await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.pending-frame','user',${f.ctx.userId!}::uuid)`;
   const [physical]=await tx`select pg_current_xact_id()::text as xid,pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started`;xid=physical.xid;backend.value={pid:physical.pid,started:physical.started};ready.resolve();await release.promise;context.signal.throwIfAborted();});void pending.catch(()=>{});
  try{await Promise.race([ready.promise,pending.then(()=>{throw Error('Active native frame exited before observation');})]);
   expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame where root_xid=${xid}::xid8`)[0].n).toBe(0);
   await owner.client`select reward_audit_policy_private.cleanup_frames(64)`;release.resolve();await pending;
   expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame where root_xid=${xid}::xid8`)[0].n).toBe(1);
   expect((await owner.client`select reward_audit_policy_private.cleanup_frames(64)as n`)[0].n).toBe(1);expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame`)[0].n).toBe(0);
   if(!backend.value)throw Error('Actual active backend identity absent');expect((await connection`select pg_backend_pid()as pid,backend_start::text as started from pg_stat_activity where pid=pg_backend_pid()`)[0]).toEqual(backend.value);
   await owner.client.begin(async tx=>{await tx`select app._domain_event_next(${f.b.tenantId}::uuid)`;expect((await tx`select reward_audit_policy_private.cleanup_frames(64)as n`)[0].n).toBe(0);expect((await tx`select count(*)::int as n from reward_audit_policy_private.floor_frame where root_xid=pg_current_xact_id()`)[0].n).toBe(1);});
  }finally{release.resolve();await pending;context.signal.removeEventListener('abort',abort);}
 });
 nativeIt(8,async()=>{
  const f=await setup();await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);await owned().family.libraries(f.ctx,'salary',f.year);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
  await owner.client`alter role ai_hr_reward_audit_read nologin`;
  try{await refusal(owned().family.libraries(f.ctx,'salary',f.year),'55000');expect((await event(app(),f.ctx,'policy.reader-unavailable')).chain_seq).toBe(1);}
  finally{await owner.client`alter role ai_hr_reward_audit_read login`;await owner.client`select reward_audit_policy_private.assert_profile()`;}
 });
 nativeIt(9,async context=>{
  const f=await setup(),old=app(),ready=deferred(),release=deferred();const abort=()=>release.resolve();context.signal.addEventListener('abort',abort,{once:true});
  const pending=old.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);await tx`select count(*)from public.domain_event where tenant_id=${f.b.tenantId}::uuid`;ready.resolve();await release.promise;context.signal.throwIfAborted();
   const [row]=await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.stale-rr-must-refuse','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`;return row;});void pending.catch(()=>{});
  try{await Promise.race([ready.promise,pending.then(()=>{throw Error('Old RR carrier exited before controlled floor COMMIT');})]);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);await owned().family.libraries(f.ctx,'salary',f.year);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);release.resolve();await refusal(pending,'40001');
   expect((await owner.client`select count(*)::int as n from public.domain_event where tenant_id=${f.b.tenantId}::uuid and event_type='policy.stale-rr-must-refuse'`)[0].n).toBe(0);
   const fresh=app();const result=await fresh.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);return(await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.fresh-rr-floor','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0];});expect(result.seq).toBe(1);
   expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`)[0].n).toBe(1);
  }finally{release.resolve();await Promise.allSettled([pending]);context.signal.removeEventListener('abort',abort);}
 });
 nativeIt(10,async()=>{
  const f=await setup();await owner.client.begin(async tx=>{
   await tx`savepoint first_floor_frame`;expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`)[0].value).toEqual({armed:false,priorSeq:null,priorHash:null});
   expect((await tx`select count(*)::int as n from reward_audit_policy_private.floor_frame where tenant_id=${f.b.tenantId}::uuid and root_xid=pg_current_xact_id()`)[0].n).toBe(1);
   await tx`rollback to savepoint first_floor_frame`;await tx`release savepoint first_floor_frame`;
   expect((await tx`select count(*)::int as n from reward_audit_policy_private.floor_frame where tenant_id=${f.b.tenantId}::uuid and root_xid=pg_current_xact_id()`)[0].n).toBe(0);
   await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);await owned().family.libraries(f.ctx,'salary',f.year);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
   expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`)[0].value).toEqual({armed:true,priorSeq:null,priorHash:null});
   expect((await tx`select observed_floor from reward_audit_policy_private.floor_frame where tenant_id=${f.b.tenantId}::uuid and root_xid=pg_current_xact_id()`)[0].observed_floor).toBe(true);
  });
 });
 nativeIt(11,async()=>{
  const f=await setup();await owner.client.begin(async tx=>{
   expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`)[0].value).toEqual({armed:false,priorSeq:null,priorHash:null});
   await tx`select set_config('app.audit_hash_chain','on',true)`;expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`)[0].value.armed).toBe(true);
   await tx`select set_config('app.audit_hash_chain','off',true)`;expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`)[0].value.armed).toBe(false);
   await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`)[0].value.armed).toBe(true);
   await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`)[0].value.armed).toBe(false);
   await tx`select set_config('app.audit_hash_chain','on',true)`;await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.fresh-components','system')`;await tx`select set_config('app.audit_hash_chain','off',true)`;
   expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as value`)[0].value).toMatchObject({armed:true,priorSeq:1});
   expect((await tx`select observed_floor from reward_audit_policy_private.floor_frame where tenant_id=${f.b.tenantId}::uuid and root_xid=pg_current_xact_id()`)[0].observed_floor).toBe(false);
  });
 });
 nativeIt(12,async()=>{
  const f=await setup();
  for(const mode of ['repeatable read','serializable']){
   const connection=app();await connection.begin('isolation level '+mode,async tx=>{
    await stamp(tx,f.ctx);await tx`set constraints all immediate`;
    // Actual event trigger -> History lock -> fixed-snapshot uniqueness probe.
    // A second append reuses only the bound floor bit and still advances head.
    for(const index of [1,2])expect((await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,${'policy.probe-'+mode+'-'+index},'user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0].seq).toBeNull();
    await tx`set constraints all immediate`;
   });
   expect(await owner.client`select * from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`).toHaveLength(0);
  }
  // Native private state is observable only by the test owner. Every observed
  // committed false frame is real; no caller-supplied verified flags exist.
  expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame where tenant_id=${f.b.tenantId}::uuid and not observed_floor`)[0].n).toBe(2);
 });
 nativeIt(13,async context=>{
  const f=await setup();
  for(const immediate of [false,true])await refusal(owner.client.begin(async tx=>{
   if(immediate)await tx`set constraints all immediate`;
   await tx`insert into reward_audit_policy_private.floor_marker(tenant_id,policy_version)values(${f.b.tenantId}::uuid,1)`;
  }),'55000');
  expect(await owner.client`select * from reward_audit_policy_private.floor_marker`).toHaveLength(0);
  await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);
  const older=reader(),observed=deferred(),finalize=deferred();let olderId:string|undefined;
  const abort=()=>finalize.resolve();context.signal.addEventListener('abort',abort,{once:true});
  const stale=older.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);const [row]=await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`;if(typeof row.id!=='string')throw Error('Actual own old receipt identity required');olderId=row.id;observed.resolve();await finalize.promise;context.signal.throwIfAborted();return tx`select * from reward_audit_read.finalize_read(${row.id}::uuid)`;});void stale.catch(()=>{});
  let firstId:string|undefined;
  try{
   await Promise.race([observed.promise,stale.then(()=>{throw Error('Older own read exited before genuine first receipt');})]);
   firstId=(await owned().family.libraries(f.ctx,'salary',f.year)).receipt.id;finalize.resolve();await refusal(stale,'40001');
  }finally{finalize.resolve();await Promise.allSettled([stale]);context.signal.removeEventListener('abort',abort);}
  expect((await owner.client`select count(*)::int as n from reward_audit_private.receipt where id=${olderId!}::uuid`)[0].n).toBe(0);
  expect((await reader().begin('isolation level repeatable read read only',async tx=>{await stamp(tx,f.ctx);return tx`select reward_audit_read.reconcile_receipt(${olderId!}::uuid)as value`;}))[0].value).toBeNull();
  const before=Array.from(await owner.client`select * from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`);
  expect(before).toHaveLength(1);expect(before[0].receipt_id).toBe(firstId);
  const later=await owned().family.pat(f.ctx,f.year);expect(later.receipt.id).not.toBe(firstId);
  expect(Array.from(await owner.client`select * from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`)).toEqual(before);
  await refusal(owner.client`update reward_audit_policy_private.floor_marker set receipt_id=${later.receipt.id}::uuid where tenant_id=${f.b.tenantId}::uuid`,'42501');
  await refusal(owner.client`delete from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`,'42501');
  expect((await owner.client`select count(*)::int as n from reward_audit_private.receipt where tenant_id=${f.b.tenantId}::uuid`)[0].n).toBe(2);
 });
 nativeIt(14,async context=>{
  const f=await setup(),first=app(),second=app(),holder=app();
  const firstIdentity=await backend(first),secondIdentity=await backend(second),holderIdentity=await backend(holder);
  await owned().fixture.withProbeBarrier(f.b.tenantId,async key=>{
   await holder`select pg_advisory_lock(${key}::text::bigint)`;let a:Promise<unknown>|undefined,b:Promise<unknown>|undefined;
   try{
    a=first.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);return(await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.two-rr-first','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0];});void a.catch(()=>{});
    await blocking(context,firstIdentity,holderIdentity);
    b=second.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);return(await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.two-rr-second','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0];});void b.catch(()=>{});
    await blocking(context,secondIdentity,firstIdentity);
    expect((await holder`select pg_advisory_unlock(${key}::text::bigint)as released`)[0].released).toBe(true);
    expect(await a).toEqual({seq:null});expect(await b).toEqual({seq:null});
    expect(await owner.client`select tenant_id from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`).toHaveLength(0);
    expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame where tenant_id=${f.b.tenantId}::uuid and not observed_floor`)[0].n).toBe(2);
   }finally{
    await holder`select pg_advisory_unlock_all()`;await Promise.allSettled([a,b].filter((value):value is Promise<unknown>=>value!==undefined));
   }
  });
 });
 nativeIt(15,async context=>{
  const f=await setup(),readerConnection=reader(),writer=app(),holder=app(),observed=deferred(),finalize=deferred();let receiptId:string|undefined;
  const readerIdentity=await backend(readerConnection),writerIdentity=await backend(writer),holderIdentity=await backend(holder);
  await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);
  const abort=()=>finalize.resolve();context.signal.addEventListener('abort',abort,{once:true});
  const receipt=readerConnection.begin('isolation level repeatable read',async tx=>{
   await stamp(tx,f.ctx);const [row]=await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`;if(typeof row.id!=='string')throw Error('Actual receipt admission identity required');receiptId=row.id;observed.resolve();await finalize.promise;context.signal.throwIfAborted();
   return(await tx`select * from reward_audit_read.finalize_read(${row.id}::uuid)`)[0];
  });void receipt.catch(()=>{});
  let command:Promise<unknown>|undefined;
  try{
   await Promise.race([observed.promise,receipt.then(()=>{throw Error('Actual armed read exited before controlled probe');})]);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
   await owned().fixture.withProbeBarrier(f.b.tenantId,async key=>{
    await holder`select pg_advisory_lock(${key}::text::bigint)`;
    try{
     command=writer.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);return(await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.probe-before-first-floor','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0];});void command.catch(()=>{});
     await blocking(context,writerIdentity,holderIdentity);finalize.resolve();
     await blocking(context,readerIdentity,writerIdentity);
     expect((await holder`select pg_advisory_unlock(${key}::text::bigint)as released`)[0].released).toBe(true);
     expect(await command).toEqual({seq:null});expect((await receipt).id).toBe(receiptId);
    }finally{finalize.resolve();await holder`select pg_advisory_unlock_all()`;await Promise.allSettled([receipt,...(command?[command]:[])]);}
   });
   expect((await owner.client`select receipt_id from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`)[0].receipt_id).toBe(receiptId);
   expect((await owner.client`select count(*)::int as n from reward_audit_private.receipt where id=${receiptId!}::uuid`)[0].n).toBe(1);
   expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame where tenant_id=${f.b.tenantId}::uuid and not observed_floor`)[0].n).toBe(1);
   expect((await event(app(),f.ctx,'policy.fresh-after-transient-probe')).chain_seq).toBe(1);
  }finally{finalize.resolve();await Promise.allSettled([receipt,...(command?[command]:[])]);context.signal.removeEventListener('abort',abort);}
 });
 async function bankFirstFloorRace(context:TestContext,counterexample:boolean){
  const f=await setup(),pack=requirePackFor('MY');
  await pack.statutory.set(f.ctx,{personId:f.person.personId,icNumber:null,epfNumber:'FICTIONAL-RETAINED-EPF',socsoNumber:'FICTIONAL-RETAINED-SOCSO',taxNumber:'FICTIONAL-RETAINED-TAX',bankName:'Fictional legacy bank',bankAccountNo:'FLOOR-OLD'});
  await pack.statutory.setBank(f.ctx,{personId:f.person.personId,bankName:'Fictional legacy bank',bankAccountNo:'FLOOR-OLD',enableCustomHolderName:true,customHolderName:'Fictional old payee',enableCustomHolderId:true,customHolderId:'FICTIONAL-OLD-HOLDER'});
  const fields={bankName:pack.client.bankNames[0],bankAccountNo:'FLOOR-NEW',enableCustomHolderName:false,customHolderName:'discarded disabled name',enableCustomHolderId:false,customHolderId:'discarded disabled ID'};
  const human=Bank.Human.parse({action:Bank.action,contractVersion:1,employmentId:f.person.employmentId,subjectId:f.person.personId,fields}),prepared=(await bankMaintenanceReviews.prepare(f.ctx,human)).review;
  const nativeBefore=Array.from(await owner.client`select to_jsonb(s)as value from public.employee_statutory_my s where s.tenant_id=${f.b.tenantId}::uuid order by s.id`),financial=await money(f.b.tenantId);
  // Older reader establishes true BEFORE the setting writer; no setting writer
  // is attempted behind the Bank command's subsequently owned Access barrier.
  const connection=reader(),observed=deferred(),finalize=deferred(),bankEntered=deferred(),finishBank=deferred();let bankPid=0,bankStart='',receiptId:string|undefined;
  await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);
  const abort=()=>{finalize.resolve();finishBank.resolve();};context.signal.addEventListener('abort',abort,{once:true});
  const receipt=connection.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);const [row]=await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`;if(typeof row.id!=='string')throw Error('Actual older armed reader required');receiptId=row.id;observed.resolve();await finalize.promise;context.signal.throwIfAborted();return(await tx`select * from reward_audit_read.finalize_read(${row.id}::uuid)`)[0];});void receipt.catch(()=>{});
  let command:Promise<string>|undefined;
  try{
   await Promise.race([observed.promise,receipt.then(()=>{throw Error('Actual older reader exited before native Bank PRE');})]);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
   const exercise=async()=>{
    command=database.withTenant(f.ctx,async tx=>{
     await tx.execute(sql`select app.assistant_bank_review_arm(${prepared.actionId}::uuid)`);
     const [frame]=await tx.execute<{pid:number;started:string;pre:{armed:boolean;priorSeq:null;priorHash:null};history:boolean}>(sql`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,bank_audit_preimage as pre,exists(select 1 from pg_locks where pid=pg_backend_pid()and locktype='advisory'and granted and mode='ExclusiveLock'and objsubid=1 and classid=((hashtext(${'audit-chain:'+f.b.tenantId})::bigint>>32)&4294967295)::oid and objid=(hashtext(${'audit-chain:'+f.b.tenantId})::bigint&4294967295)::oid)as history from app.assistant_own_leave_review where id=${prepared.actionId}::uuid`);
     // Derive both physical advisory-key halves natively, including sign.
     expect(frame.history).toBe(true);expect(frame.pre).toEqual({armed:false,priorSeq:null,priorHash:null});bankPid=frame.pid;bankStart=frame.started;bankEntered.resolve();await finishBank.promise;context.signal.throwIfAborted();
     const native=await pack.statutory.setBank(f.ctx,{personId:f.person.personId,...fields},tx);
     const events=await tx.execute<{id:string}>(sql`select id from public.domain_event where tenant_id=${f.b.tenantId}::uuid and aggregate_id=${native.id}::uuid and event_type='employee.bank.updated'and xmin=pg_current_xact_id()::xid`);expect(events).toHaveLength(1);
     await tx.execute(sql`select app.assistant_assigned_review_complete(${prepared.actionId}::uuid,${Bank.action},${prepared.reviewedDigest},${events[0].id}::uuid)`);return events[0].id;
    });void command.catch(()=>{});
    try{
     await Promise.race([bankEntered.promise,command.then(()=>{throw Error('Native Bank exited before real PRE witness');})]);
     expect((await owner.client`select exists(select 1 from pg_stat_activity where pid=${bankPid} and backend_start=${bankStart}::text::timestamptz and usename='ai_hr_app')as actual`)[0].actual).toBe(true);
     finalize.resolve();expect((await receipt).id).toBe(receiptId);finishBank.resolve();
     if(counterexample){await refusal(command,'42501');expect(Array.from(await owner.client`select to_jsonb(s)as value from public.employee_statutory_my s where s.tenant_id=${f.b.tenantId}::uuid order by s.id`)).toEqual(nativeBefore);}
     else{
      const eventId=await command;expect((await owner.client`select chain_seq is null and hash is null and prev_hash is null as retained_unarmed,app._domain_event_preimage_for(e)=r.bank_audit_preimage as same_pre from public.domain_event e join app.assistant_own_leave_review r on r.receipt_event_id=e.id where e.id=${eventId}::uuid`)[0]).toEqual({retained_unarmed:true,same_pre:true});
      expect((await owner.client`select bank_account_no as account,epf_number as epf,socso_number as socso,tax_number as tax from public.employee_statutory_my where tenant_id=${f.b.tenantId}::uuid and person_id=${f.person.personId}::uuid`)[0]).toEqual({account:'FLOOR-NEW',epf:'FICTIONAL-RETAINED-EPF',socso:'FICTIONAL-RETAINED-SOCSO',tax:'FICTIONAL-RETAINED-TAX'});
     }
    }finally{finishBank.resolve();await Promise.allSettled([receipt,...(command?[command]:[])]);}
   };
   if(counterexample)await owned().fixture.withFreshFloorCounterexample(exercise);else await exercise();
   expect(await money(f.b.tenantId)).toEqual(financial);expect((await event(app(),f.ctx,'policy.after-bank-first-floor')).chain_seq).toBe(1);
  }finally{finalize.resolve();finishBank.resolve();await Promise.allSettled([receipt,...(command?[command]:[])]);context.signal.removeEventListener('abort',abort);}
 }
 nativeIt(16,context=>bankFirstFloorRace(context,true));
 nativeIt(17,context=>bankFirstFloorRace(context,false));
 async function catalogueFirstFloorRace(context:TestContext,counterexample:boolean){
  const f=await setup(),human={action:'org.position.archive' as const,contractVersion:1 as const,positionId:f.b.positionId,expectedArchived:false,archived:true};
  const prepared=(await positionArchiveReviews.prepare(f.ctx,human)).review;
  const before=Array.from(await owner.client`select to_jsonb(p)as value from public.position p where p.tenant_id=${f.b.tenantId}::uuid order by p.id`),financial=await money(f.b.tenantId);
  const connection=reader(),observed=deferred(),finalize=deferred(),entered=deferred(),finish=deferred();
  await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);
  const abort=()=>{finalize.resolve();finish.resolve();};context.signal.addEventListener('abort',abort,{once:true});
  const receipt=connection.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);const [row]=await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`;observed.resolve();await finalize.promise;context.signal.throwIfAborted();return(await tx`select * from reward_audit_read.finalize_read(${row.id}::uuid)`)[0];});void receipt.catch(()=>{});
  let command:Promise<unknown>|undefined,armedCallbacks=0;
  const actualBulk=adminOwner.bulkSaveLabels,actualSqlState=nativeErrorOwner.pgSqlState,actualErrorChain=nativeErrorOwner.pgErrorChain;const nativeRefusals:Array<{code:string;message:string}>=[];
  try{
   await Promise.race([observed.promise,receipt.then(()=>{throw Error('Actual older read exited before Catalogue PRE');})]);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
   const exercise=async()=>{
    // Transparent observation: every callback forwards unchanged arguments to
    // the real canonical owner; no owner result or authorization is fabricated.
    const errors=vi.spyOn(nativeErrorOwner,'pgSqlState').mockImplementation(error=>{const code=actualSqlState(error);if(code){const native=actualErrorChain(error).find(link=>link.code===code);nativeRefusals.push({code,message:native?.message??''});}return code;});
    const callback=vi.spyOn(adminOwner,'bulkSaveLabels').mockImplementation(async(...args:Parameters<typeof adminOwner.bulkSaveLabels>)=>{
     const [ctx,kind,,tx]=args;
     if(tx&&ctx.tenantId===f.b.tenantId&&kind==='position'){
      const [frame]=await tx.execute<{phase:string|null;pre:unknown;pid:number;started:string;history:boolean}>(sql`select catalogue_native_phase as phase,catalogue_audit_preimage as pre,pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,exists(select 1 from pg_locks where pid=pg_backend_pid()and locktype='advisory'and granted and mode='ExclusiveLock'and objsubid=1 and classid=((hashtext(${'audit-chain:'+f.b.tenantId})::bigint>>32)&4294967295)::oid and objid=(hashtext(${'audit-chain:'+f.b.tenantId})::bigint&4294967295)::oid)as history from app.assistant_own_leave_review where id=${prepared.actionId}::uuid`);
      if(frame?.phase==='armed'){
       armedCallbacks++;expect(armedCallbacks).toBe(1);expect(frame.history).toBe(true);expect(frame.pre).toEqual({armed:false,priorSeq:null,priorHash:null});
       expect((await owner.client`select exists(select 1 from pg_stat_activity where pid=${frame.pid} and backend_start=${frame.started}::text::timestamptz and usename='ai_hr_app')as actual`)[0].actual).toBe(true);
       entered.resolve();await finish.promise;context.signal.throwIfAborted();
      }
     }
     return actualBulk(...args);
    });
    try{
     command=positionArchiveReviews.confirm(f.ctx,{action:human.action,contractVersion:1,actionId:prepared.actionId,reviewedDigest:prepared.reviewedDigest});void command.catch(()=>{});
     await Promise.race([entered.promise,command.then(()=>{throw Error('Actual Catalogue command exited before armed callback');})]);
     finalize.resolve();await receipt;finish.resolve();
     if(counterexample){
      await expect(command).rejects.toThrow();expect(nativeRefusals).toContainEqual({code:'42501',message:'Catalogue audit decision changed before native INSERT'});
      expect(Array.from(await owner.client`select to_jsonb(p)as value from public.position p where p.tenant_id=${f.b.tenantId}::uuid order by p.id`)).toEqual(before);
     }else{
      expect(await command).toMatchObject({kind:'completed',receipt:{receipt:{positionId:f.b.positionId,archived:true}}});
      expect((await owner.client`select p.archived_at is not null as archived,e.chain_seq is null and e.hash is null and e.prev_hash is null as retained_unarmed,app._domain_event_preimage_for(e)='{"armed":false,"priorSeq":null,"priorHash":null}'::jsonb as same_pre from public.position p join app.assistant_own_leave_review r on r.receipt_subject_id=p.id join public.domain_event e on e.id=r.receipt_event_id where r.id=${prepared.actionId}::uuid`)[0]).toEqual({archived:true,retained_unarmed:true,same_pre:true});
     }
     expect(armedCallbacks).toBe(1);
    }finally{finish.resolve();await Promise.allSettled([receipt,...(command?[command]:[])]);callback.mockRestore();errors.mockRestore();}
   };
   if(counterexample)await owned().fixture.withFreshFloorCounterexample(exercise);else await exercise();
   expect(await money(f.b.tenantId)).toEqual(financial);expect((await event(app(),f.ctx,'policy.after-catalogue-first-floor')).chain_seq).toBe(1);
  }finally{finalize.resolve();finish.resolve();await Promise.allSettled([receipt,...(command?[command]:[])]);context.signal.removeEventListener('abort',abort);}
 }
 nativeIt(18,context=>catalogueFirstFloorRace(context,true));
 nativeIt(19,context=>catalogueFirstFloorRace(context,false));
 async function receiptProcessKill(context:TestContext,phase:'before-commit'|'after-commit'){
  const f=await setup(),financial=await money(f.b.tenantId);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);
  const process=await rewardPolicyReaderProcess(owned().fixture,f.ctx,context.signal,controller.registerStop);
  try{
   process.read(f.year,phase);const result=await process.wait(phase==='before-commit'?'finalized':'committed');
   if(result.kind!=='finalized'&&result.kind!=='committed')throw Error('Exact native receipt process identity absent');
   expect((await owner.client`select exists(select 1 from pg_stat_activity where pid=${result.pid} and backend_start=${result.started}::text::timestamptz and usename='ai_hr_reward_audit_read'and datname=${controller.database})as actual`)[0].actual).toBe(true);
   process.child.kill('SIGKILL');expect(await process.closed).toEqual({code:null,signal:'SIGKILL'});
   let absent=false;const deadline=Date.now()+2000;
   do{context.signal.throwIfAborted();const [row]=await owner.client`select not exists(select 1 from pg_stat_activity where pid=${result.pid} and backend_start=${result.started}::text::timestamptz)as absent`;if(row.absent===true){absent=true;break;}await new Promise<void>(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
   expect(absent).toBe(true);
   const expected=phase==='after-commit'?1:0;
   expect((await owner.client`select count(*)::int as n from reward_audit_private.receipt where id=${result.receiptId}::uuid`)[0].n).toBe(expected);
   expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid and receipt_id=${result.receiptId}::uuid`)[0].n).toBe(expected);
   await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
   const restarted=await rewardPolicyReaderProcess(owned().fixture,f.ctx,context.signal,controller.registerStop);
   try{
    restarted.reconcile(result.receiptId);const fresh=await restarted.wait('reconciled');if(fresh.kind!=='reconciled')throw Error('Actual restarted receipt reconciliation required');
    expect(fresh.pid!==result.pid||fresh.started!==result.started).toBe(true);
    if(phase==='before-commit')expect(fresh.value).toBeNull();else expect(fresh.value).toMatchObject({id:result.receiptId,armed:true,projected:false});
    expect(await restarted.closed).toEqual({code:0,signal:null});
   }finally{await restarted.stop();}
   expect((await event(app(),f.ctx,'policy.after-receipt-process-kill')).chain_seq).toBe(phase==='after-commit'?1:null);
   expect(await money(f.b.tenantId)).toEqual(financial);
  }finally{await process.stop();}
 }
 nativeIt(20,context=>receiptProcessKill(context,'before-commit'));
 nativeIt(21,context=>receiptProcessKill(context,'after-commit'));
 async function policyEffects(){return(await owner.client`select jsonb_build_object('observations',(select jsonb_agg(to_jsonb(o)order by id)from reward_audit_policy_private.observation o),'markers',(select jsonb_agg(to_jsonb(m)order by tenant_id)from reward_audit_policy_private.floor_marker m),'receipts',(select jsonb_agg(to_jsonb(r)order by id)from reward_audit_private.receipt r),'projections',(select jsonb_agg(to_jsonb(p)order by receipt_id)from reward_audit_private.projection p))as value`)[0].value;}
 nativeIt(22,async()=>{
  const f=await setup(),api=owned().family,other=await seedBase();await setModule(other.tenantId,'rewards','active');await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);const valid=await api.libraries(f.ctx,'salary',f.year),before=await policyEffects(),financial=await money(f.b.tenantId),oldStatus=(await owner.client`select status from public.tenant where id=${f.b.tenantId}::uuid`)[0].status;
  const reconnect=()=>reader().begin('isolation level repeatable read read only',async tx=>{await stamp(tx,f.ctx);return(await tx`select reward_audit_read.reconcile_receipt(${valid.receipt.id}::uuid)as value`)[0].value;});
  expect(await reconnect()).toMatchObject({id:valid.receipt.id,armed:true,projected:false});
  await refusal(api.libraries({...adminCtx(other),userId:f.ctx.userId,personId:f.ctx.personId,roles:f.ctx.roles,grants:f.ctx.grants}));
  await refusal(api.libraries({...f.ctx,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]}));
  await owner.client`delete from public.role_assignment where app_user_id=${f.ctx.userId!}::uuid`;await refusal(api.libraries(f.ctx));await refusal(reconnect());
  await owner.client`insert into public.role_assignment(tenant_id,app_user_id,role,company_id)values(${f.b.tenantId}::uuid,${f.ctx.userId!}::uuid,'hr_admin',null)`;
  await owner.client`update public.app_user set archived_at=clock_timestamp()where id=${f.ctx.userId!}::uuid`;await refusal(api.libraries(f.ctx));await refusal(reconnect());await owner.client`update public.app_user set archived_at=null where id=${f.ctx.userId!}::uuid`;
  await owner.client`update public.tenant_module set status='disabled'where tenant_id=${f.b.tenantId}::uuid and module_code='rewards'`;await refusal(api.libraries(f.ctx));await refusal(reconnect());await owner.client`update public.tenant_module set status='active'where tenant_id=${f.b.tenantId}::uuid and module_code='rewards'`;
  await owner.client`update public.tenant set status='suspended'where id=${f.b.tenantId}::uuid`;await refusal(api.libraries(f.ctx));await refusal(reconnect());await owner.client`update public.tenant set status=${oldStatus} where id=${f.b.tenantId}::uuid`;
  expect(await policyEffects()).toEqual(before);expect(await money(f.b.tenantId)).toEqual(financial);expect(await reconnect()).toMatchObject({id:valid.receipt.id,armed:true});
 });
 nativeIt(23,async()=>{
  const f=await setup(),user=await createAppUser(f.b.tenantId,null,'employee'),ctx={...f.ctx,userId:user,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]},api=owned().family;
  const [grant]=await owner.client`insert into public.reward_setup_grant(tenant_id,user_id,company_id,role,valid_from,created_by,reason)values(${f.b.tenantId}::uuid,${user}::uuid,null,'ctro','2000-01-01',${f.ctx.userId!}::uuid,'Fictional native policy CTRO view')returning id`;
  const baseline=await rewardLibraries(ctx,'salary',f.year);expect(baseline.map(row=>row.id)).toEqual([f.ids.salary_version_id]);expect((await api.libraries(ctx,'salary',f.year)).data).toEqual(baseline);
  const before=await policyEffects(),financial=await money(f.b.tenantId);await refusal(api.pat(ctx,f.year));
  await owner.client`update public.reward_setup_grant set active=false where id=${grant.id}::uuid`;await refusal(api.libraries(ctx,'salary',f.year));
  await owner.client`update public.reward_setup_grant set role='gr',active=true,company_id=${f.b.companyId}::uuid where id=${grant.id}::uuid`;await refusal(api.libraries(ctx));await refusal(api.pat(ctx,f.year));
  expect(await policyEffects()).toEqual(before);expect(await money(f.b.tenantId)).toEqual(financial);
 });
 // These24 declarations are source only until the authenticated thin entrypoint
 // and complete owned source closure are converged by the root controller owner.
}
