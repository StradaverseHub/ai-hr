/** Compiled native cases, intentionally not a standalone selector on the old315 base.
 * Root convergence must add a thin real admitSingletonTest entrypoint BEFORE calling
 * registration. This module cannot create CI evidence, grants or release authority. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import postgres from 'postgres';
import {z} from 'zod';
import {assertAiPrincipalTx} from '../../core/ai-principal';
import {assertReportPrincipalTx,MasterReportAccessError} from '../../core/employee-master-access';
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
import {controlledPolicyWait} from './rewards-audit-policy-controlled-wait';
import {waitRewardPolicyNativeProgress} from './rewards-audit-policy-native-progress';
import {rewardsPolicyDiagnostics} from './rewards-audit-policy-diagnostic';
import {rewardPolicyNativeSaveObservation} from './rewards-audit-policy-native-save-observation';

// Registered by Vitest BEFORE the review-store imports evaluate their factory
// specs. A case-time spy cannot replace those already captured function values.
const observationContext=vi.hoisted(()=>{const state:{current:ReturnType<typeof rewardsPolicyDiagnostics>|undefined}={current:undefined};return state;});
vi.mock('../../core/assistant-actions/agent-action-guard',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../core/assistant-actions/agent-action-guard')>();
 const {rewardPolicyObservedCallback}=await import('./rewards-audit-policy-observation-context');
 const withAgentActionGuard:typeof actual.withAgentActionGuard=(...args)=>rewardPolicyObservedCallback(()=>observationContext.current,'agent-guard',()=>actual.withAgentActionGuard(...args));
 return{...actual,withAgentActionGuard};
});
vi.mock('../../core/assistant-actions/bank-maintenance-source',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../core/assistant-actions/bank-maintenance-source')>();
 const {rewardPolicyObservedCallback}=await import('./rewards-audit-policy-observation-context');
 const assertBankMaintenanceActorTx:typeof actual.assertBankMaintenanceActorTx=(...args)=>rewardPolicyObservedCallback(()=>observationContext.current,'bank-actor',()=>actual.assertBankMaintenanceActorTx(...args));
 const withBankMaintenanceIntervalTx:typeof actual.withBankMaintenanceIntervalTx=(tx,ctx,id,work)=>rewardPolicyObservedCallback(()=>observationContext.current,'bank-interval',()=>actual.withBankMaintenanceIntervalTx(tx,ctx,id,work));
 const prepareBankMaintenanceSourceTx:typeof actual.prepareBankMaintenanceSourceTx=(...args)=>rewardPolicyObservedCallback(()=>observationContext.current,'bank-source',()=>actual.prepareBankMaintenanceSourceTx(...args));
 return{...actual,assertBankMaintenanceActorTx,withBankMaintenanceIntervalTx,prepareBankMaintenanceSourceTx};
});
vi.mock('../../core/assistant-actions/position-archive-source',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../core/assistant-actions/position-archive-source')>();
 const {rewardPolicyObservedCallback}=await import('./rewards-audit-policy-observation-context');
 const lockPositionArchiveSourceTx:typeof actual.lockPositionArchiveSourceTx=(...args)=>rewardPolicyObservedCallback(()=>observationContext.current,'catalogue-lock',()=>actual.lockPositionArchiveSourceTx(...args));
 const preparePositionArchiveTx:typeof actual.preparePositionArchiveTx=(...args)=>rewardPolicyObservedCallback(()=>observationContext.current,'catalogue-source',()=>actual.preparePositionArchiveTx(...args));
 const confirmPositionArchiveTx:typeof actual.confirmPositionArchiveTx=(...args)=>rewardPolicyObservedCallback(()=>observationContext.current,'catalogue-confirm',()=>actual.confirmPositionArchiveTx(...args));
 return{...actual,lockPositionArchiveSourceTx,preparePositionArchiveTx,confirmPositionArchiveTx};
});
vi.mock('../../core/admin',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../core/admin')>();
 const {rewardPolicyObservedCallback}=await import('./rewards-audit-policy-observation-context');
 const bulkSaveLabels:typeof actual.bulkSaveLabels=(...args)=>rewardPolicyObservedCallback(()=>observationContext.current,'catalogue-native-save',()=>actual.bulkSaveLabels(...args));
 return{...actual,bulkSaveLabels};
});
vi.mock('../../core/assistant-actions/generic-review-custody',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../core/assistant-actions/generic-review-custody')>();
 const {rewardPolicyObservedParse}=await import('./rewards-audit-policy-observation-context');
 const createReviewCustody:typeof actual.createReviewCustody=spec=>{
  if(spec.action==='employees.bank.maintain')return actual.createReviewCustody({...spec,metadata:rewardPolicyObservedParse(spec.metadata,()=>observationContext.current,'bank-metadata-parse'),stored:rewardPolicyObservedParse(spec.stored,()=>observationContext.current,'bank-stored-parse')});
  if(spec.action==='org.position.archive')return actual.createReviewCustody({...spec,metadata:rewardPolicyObservedParse(spec.metadata,()=>observationContext.current,'catalogue-metadata-parse'),stored:rewardPolicyObservedParse(spec.stored,()=>observationContext.current,'catalogue-stored-parse')});
  return actual.createReviewCustody(spec);
 };
 return{...actual,createReviewCustody};
});

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
export function registerRewardsAuditPolicyNativeCases(evidenceDirectory:string){
 const controller=rewardsAuditPolicyController(),ownership=controller.lifetime,realWithTenant=database.withTenant;
 let fixture:RewardsAuditPolicyFixtureOwner|undefined,family:ReturnType<typeof createUninstalledRewardsAuditFamily>|undefined;const caseSockets=new Set<ReturnType<typeof postgres>>();
 let diagnostics:ReturnType<typeof rewardsPolicyDiagnostics>|undefined;
 const owned=()=>{if(!fixture||!family)throw Error('Owned native policy constructor unavailable');return{fixture,family};};
 controller.registerStop(closeAll);
 beforeEach(()=>{ownership.beforeCase();vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED','false');vi.stubEnv('AI_CONFIG_SECRET','fictional-policy-custody-secret-123456789');});
 afterEach(async()=>{await ownership.drain();await Promise.all([...caseSockets].map(connection=>connection.end({timeout:0})));caseSockets.clear();await fixture?.finishCase();vi.restoreAllMocks();vi.unstubAllEnvs();});
 afterAll(async()=>{await ownership.drain();await controller.close(fixture!==undefined,async()=>{if(!fixture)throw Error('Unknown policy ownership');await fixture.close();});});
 const owner=controller.owner;
 type NativeRoot={xid:string;pid:number;started:string};
 async function rootIdentity(tx:TransactionSql):Promise<NativeRoot>{const [row]=await tx`select pg_current_xact_id()::text as xid,pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started`;if(!row||typeof row.xid!=='string'||typeof row.pid!=='number'||typeof row.started!=='string')throw Error('Actual native root identity required');return{xid:row.xid,pid:row.pid,started:row.started};}
 async function allFrames(tenant:string){return Array.from(await owner.client`select to_jsonb(f)as value from reward_audit_policy_private.floor_frame f where tenant_id=${tenant}::uuid order by root_xid`).map(row=>row.value);}
 async function exactFrames(tenant:string,before:readonly unknown[],roots:readonly NativeRoot[]){
  expect(new Set(roots.map(root=>root.xid)).size).toBe(roots.length);
  const added=Array.from(await owner.client`select jsonb_build_object('tenant_id',${tenant}::uuid,'root_xid',r.xid::xid8,'backend_pid',r.pid,'backend_started_at',r.started::timestamptz,'policy_version',1,'observed_floor',false)as value from jsonb_to_recordset(${JSON.stringify(roots)}::text::jsonb)as r(xid text,pid integer,started text)`).map(row=>row.value);
  const complete=(rows:readonly unknown[])=>rows.map(row=>JSON.stringify(row)).sort();
  expect(complete(await allFrames(tenant))).toEqual(complete([...before,...added]));
 }

 async function backend(connection:ReturnType<typeof postgres>){const [row]=await connection`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started`;if(!row||typeof row.pid!=='number'||typeof row.started!=='string')throw Error('Actual native session identity required');return{pid:row.pid,started:row.started};}
 async function blocking(context:TestContext,waiting:{pid:number;started:string},holder:{pid:number;started:string},tenant:string){
  const until=Date.now()+200;
  do{context.signal.throwIfAborted();const [row]=await owner.client`select exists(select 1 from pg_stat_activity w,pg_stat_activity h where w.pid=${waiting.pid} and w.backend_start=${waiting.started}::text::timestamptz and h.pid=${holder.pid} and h.backend_start=${holder.started}::text::timestamptz and h.pid=any(pg_blocking_pids(w.pid)))as owned`;
   if(row.owned===true)return;await new Promise<void>(resolve=>setTimeout(resolve,5));
  }while(Date.now()<until);
  const primary=Error('Actual bounded native blocking witness unavailable');
  try{context.signal.throwIfAborted();if(!diagnostics)throw Error('No owned diagnostic case');diagnostics.wait(await controller.waitSnapshot(waiting,holder,tenant,context.signal));}
  catch(error){throw new AggregateError([primary,error],'Native wait witness and diagnostic unavailable',{cause:primary});}
  throw primary;
 }


 async function ownsNativeFloorWrite(waiting:{pid:number;started:string}){
  const [row]=await owner.client`select exists(select 1 from pg_stat_activity a join pg_locks l on l.pid=a.pid
   where a.pid=${waiting.pid} and a.backend_start=${waiting.started}::text::timestamptz and a.datname=${controller.database}
   and l.locktype='relation' and l.relation='reward_audit_policy_private.floor_marker'::regclass and l.granted and l.mode='RowExclusiveLock')as ready`;
  if(!row||typeof row.ready!=='boolean')throw Error('Exact native floor write progress unavailable');return row.ready;
 }
 function nativeIt(index:number,work:(ctx:TestContext)=>Promise<void>){it(rewardsAuditPolicyNativeCaseNames[index],context=>ownership.run(context,async()=>{
  const observed=rewardsPolicyDiagnostics();if(observationContext.current)throw Error('Previous canonical observations have not drained');diagnostics=observed;observationContext.current=observed;
  // Only budget instrumentation: every real application Tx and canonical service
  // still executes. No native permission, source, approval or result is mocked.
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,run:(tx:database.Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>realWithTenant(ctx,tx=>observed.callback('tenant-callback',async()=>{
   await tx.execute(sql`set local statement_timeout='20s'`);await tx.execute(sql`set local lock_timeout='300ms'`);return run(tx);
  }),options));
  await controlledPolicyWait(ownership.poison).run(()=>work(context),async()=>{
   await observed.drain();spy.mockRestore();if(observationContext.current!==observed)throw Error('Foreign canonical observation reset refused');observationContext.current=undefined;diagnostics=undefined;
   const report={...observed.snapshot(),caseIndex:index},bytes=JSON.stringify(report)+'\n';
   if(Buffer.byteLength(bytes,'utf8')>32768)throw Error('Bounded Rewards diagnostic publication refused');
   try{writeFileSync(join(evidenceDirectory,'rewards-policy-case-'+index+'-diagnostic.json'),bytes,{flag:'wx',mode:0o600});}catch{throw Error('Owned Rewards diagnostic publication unavailable');}
   if(!report.complete)throw Error('Incomplete Rewards diagnostic observations');
  });
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
 nativeIt(0,async context=>{
  try{fixture=await rewardsAuditPolicyFixtureOwner(controller.dependencies,ownership.poison,{signal:context.signal,registerStop:controller.registerStop,registerDefaultController:controller.registerDefaultController,evidenceDirectory});family=createUninstalledRewardsAuditFamily({...fixture,connectTimeoutSeconds:2});controller.registerStop(()=>owned().family.close());controller.registerStop(()=>owned().fixture.finishCase());}
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
  expect((await owner.client`select e.actor_id=r.actor_id as historical_actor,e.occurred_at=r.observed_at as historical_time,e.chain_seq::int as seq,e.prev_hash=${native.hash} as linked,e.hash=app.domain_event_hash(e.prev_hash,e.tenant_id,e.chain_seq,e.aggregate_type,e.aggregate_id,e.event_type,e.actor_type::text,e.actor_id,e.subject_employment_id,e.payload)as canonical from public.domain_event e join reward_audit_private.receipt r on r.event_id=e.id where r.id=${read.receipt.id}::uuid`)[0]).toEqual({historical_actor:true,historical_time:true,seq:2,linked:true,canonical:true});
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
  const control=controlledPolicyWait(ownership.poison),pending=control.start(()=>connection.begin(async tx=>{await stamp(tx,f.ctx);await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.pending-frame','user',${f.ctx.userId!}::uuid)`;
   const [physical]=await tx`select pg_current_xact_id()::text as xid,pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started`;xid=physical.xid;backend.value={pid:physical.pid,started:physical.started};ready.resolve();await release.promise;context.signal.throwIfAborted();}));
  await control.run(async()=>{await control.ready(ready.promise,pending,context.signal,'Active native frame exited before observation');
   expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame where root_xid=${xid}::xid8`)[0].n).toBe(0);
   await owner.client`select reward_audit_policy_private.cleanup_frames(64)`;release.resolve();await pending.value();
   expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame where root_xid=${xid}::xid8`)[0].n).toBe(1);
   expect((await owner.client`select reward_audit_policy_private.cleanup_frames(64)as n`)[0].n).toBe(1);expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_frame`)[0].n).toBe(0);
   if(!backend.value)throw Error('Actual active backend identity absent');expect((await connection`select pg_backend_pid()as pid,backend_start::text as started from pg_stat_activity where pid=pg_backend_pid()`)[0]).toEqual(backend.value);
   await owner.client.begin(async tx=>{await tx`select app._domain_event_next(${f.b.tenantId}::uuid)`;expect((await tx`select reward_audit_policy_private.cleanup_frames(64)as n`)[0].n).toBe(0);expect((await tx`select count(*)::int as n from reward_audit_policy_private.floor_frame where root_xid=pg_current_xact_id()`)[0].n).toBe(1);});
  },async()=>{release.resolve();},()=>context.signal.removeEventListener('abort',abort));
 });
 nativeIt(8,async()=>{
  const f=await setup();await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);await owned().family.libraries(f.ctx,'salary',f.year);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
  await owner.client`alter role ai_hr_reward_audit_read nologin`;
  await controlledPolicyWait(ownership.poison).run(async()=>{await refusal(owned().family.libraries(f.ctx,'salary',f.year),'55000');expect((await event(app(),f.ctx,'policy.reader-unavailable')).chain_seq).toBe(1);},async()=>{await owner.client`alter role ai_hr_reward_audit_read login`;await owner.client`select reward_audit_policy_private.assert_profile()`;});
 });
 nativeIt(9,async context=>{
  const f=await setup(),old=app(),ready=deferred(),release=deferred();const abort=()=>release.resolve();context.signal.addEventListener('abort',abort,{once:true});
  const control=controlledPolicyWait(ownership.poison),pending=control.start(()=>old.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);await tx`select count(*)from public.domain_event where tenant_id=${f.b.tenantId}::uuid`;ready.resolve();await release.promise;context.signal.throwIfAborted();
   const [row]=await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.stale-rr-must-refuse','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`;return row;}));
  await control.run(async()=>{await control.ready(ready.promise,pending,context.signal,'Old RR carrier exited before controlled floor COMMIT');await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);await owned().family.libraries(f.ctx,'salary',f.year);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);release.resolve();control.consume(pending,await refusal(pending.value(),'40001'));
   expect((await owner.client`select count(*)::int as n from public.domain_event where tenant_id=${f.b.tenantId}::uuid and event_type='policy.stale-rr-must-refuse'`)[0].n).toBe(0);
   const fresh=app();const result=await fresh.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);return(await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.fresh-rr-floor','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0];});expect(result.seq).toBe(1);
   expect((await owner.client`select count(*)::int as n from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`)[0].n).toBe(1);
  },async()=>{release.resolve();},()=>context.signal.removeEventListener('abort',abort));
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
  const f=await setup(),before=await allFrames(f.b.tenantId),roots:NativeRoot[]=[];
  for(const mode of ['repeatable read','serializable']){
   const connection=app();await connection.begin('isolation level '+mode,async tx=>{
    await stamp(tx,f.ctx);roots.push(await rootIdentity(tx));await tx`set constraints all immediate`;
    // Actual event trigger -> History lock -> fixed-snapshot uniqueness probe.
    // A second append reuses only the bound floor bit and still advances head.
    for(const index of [1,2])expect((await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,${'policy.probe-'+mode+'-'+index},'user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0].seq).toBeNull();
    await tx`set constraints all immediate`;
   });
   expect(await owner.client`select * from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`).toHaveLength(0);
  }
  // Native private state is observable only by the test owner. Every observed
  // committed false frame is real; no caller-supplied verified flags exist.
  await exactFrames(f.b.tenantId,before,roots);
  // App LOGIN retains no private INSERT privilege. The independent owner
  // control observes the SAME constraint timing after the SAME real helper,
  // in its actual RR/SERIALIZABLE transaction, rather than resetting it first.
  for(const mode of ['repeatable read','serializable']){
   const ownedBefore=await allFrames(f.b.tenantId);
   const ownRoot=await owner.client.begin('isolation level '+mode,async tx=>{
    expect((await tx`select current_user=session_user and current_user::regrole::oid=(select relowner from pg_class where oid='public.domain_event'::regclass)as native_owner,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as readonly,current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock`)[0]).toEqual({native_owner:true,isolation:mode,readonly:'off',statement:'20s',lock:'300ms'});
    const identity=await rootIdentity(tx);await tx`set constraints all immediate`;
    expect((await tx`select app._domain_event_next(${f.b.tenantId}::uuid)as pre`)[0].pre).toEqual({armed:false,priorSeq:null,priorHash:null});
    await refusal(tx.savepoint(async child=>{
     // A leaked DEFERRED state would make THIS INSERT succeed, so the
     // refusal assertion fails before any later SET CONSTRAINTS or COMMIT.
     await child`insert into reward_audit_policy_private.floor_marker(tenant_id,policy_version)values(${f.b.tenantId}::uuid,1)`;
    }),'55000');
    // postgres-js owns this child's error bookkeeping AND native rollback.
    // If the INSERT wrongly succeeds, refusal throws and the outer TX rolls
    // back everything; a fake floor can never commit on the failed assertion.
    expect((await tx`select 1 as usable,not exists(select 1 from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid)as no_marker`)[0]).toEqual({usable:1,no_marker:true});return identity;
   });
   await exactFrames(f.b.tenantId,ownedBefore,[ownRoot]);
  }
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
  const control=controlledPolicyWait(ownership.poison),stale=control.start(()=>older.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);const [row]=await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`;if(typeof row.id!=='string')throw Error('Actual own old receipt identity required');olderId=row.id;observed.resolve();await finalize.promise;context.signal.throwIfAborted();return tx`select * from reward_audit_read.finalize_read(${row.id}::uuid)`;}));
  let firstId:string|undefined;
  await control.run(async()=>{
   await control.ready(observed.promise,stale,context.signal,'Older own read exited before genuine first receipt');
   firstId=(await owned().family.libraries(f.ctx,'salary',f.year)).receipt.id;finalize.resolve();control.consume(stale,await refusal(stale.value(),'40001'));
  },async()=>{finalize.resolve();},()=>context.signal.removeEventListener('abort',abort));
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
  const f=await setup(),first=app(),second=app(),holder=app(),before=await allFrames(f.b.tenantId),roots:NativeRoot[]=[];
  const firstIdentity=await backend(first),secondIdentity=await backend(second),holderIdentity=await backend(holder);
  await owned().fixture.withProbeBarrier(f.b.tenantId,async key=>{
   const control=controlledPolicyWait(ownership.poison);
   await control.run(async()=>{
    await holder`select pg_advisory_lock(${key}::text::bigint)`;
    const a=control.start(()=>first.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);roots.push(await rootIdentity(tx));return(await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.two-rr-first','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0];}));
    await blocking(context,firstIdentity,holderIdentity,f.b.tenantId);
    const b=control.start(()=>second.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);roots.push(await rootIdentity(tx));return(await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.two-rr-second','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0];}));
    await blocking(context,secondIdentity,firstIdentity,f.b.tenantId);
    expect((await holder`select pg_advisory_unlock(${key}::text::bigint)as released`)[0].released).toBe(true);
    expect(await a.value()).toEqual({seq:null});expect(await b.value()).toEqual({seq:null});
    expect(await owner.client`select tenant_id from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`).toHaveLength(0);
    expect(roots).toHaveLength(2);await exactFrames(f.b.tenantId,before,roots);
   },async()=>{await holder`select pg_advisory_unlock_all()`;});
  });
 });
 nativeIt(15,async context=>{
  const f=await setup(),readerConnection=reader(),writer=app(),holder=app(),observed=deferred(),finalize=deferred(),before=await allFrames(f.b.tenantId),roots:NativeRoot[]=[];let receiptId:string|undefined;
  const readerIdentity=await backend(readerConnection),writerIdentity=await backend(writer),holderIdentity=await backend(holder);
  await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);
  const abort=()=>finalize.resolve();context.signal.addEventListener('abort',abort,{once:true});
  const control=controlledPolicyWait(ownership.poison),receipt=control.start(()=>readerConnection.begin('isolation level repeatable read',async tx=>{
   await stamp(tx,f.ctx);const [row]=await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`;if(typeof row.id!=='string')throw Error('Actual receipt admission identity required');receiptId=row.id;observed.resolve();await finalize.promise;context.signal.throwIfAborted();
   diagnostics?.step('receipt-finalize-submitted');return(await tx`select * from reward_audit_read.finalize_read(${row.id}::uuid)`)[0];
  }));
  await control.run(async()=>{
   await control.ready(observed.promise,receipt,context.signal,'Actual armed read exited before controlled probe');await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
   await owned().fixture.withProbeBarrier(f.b.tenantId,async key=>{
    await control.run(async()=>{
     await holder`select pg_advisory_lock(${key}::text::bigint)`;
     const command=control.start(()=>writer.begin('isolation level repeatable read',async tx=>{diagnostics?.step('writer-entered');await stamp(tx,f.ctx);diagnostics?.step('writer-stamped');roots.push(await rootIdentity(tx));diagnostics?.step('writer-insert-submitted');return(await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id)values(${f.b.tenantId}::uuid,'policy-fixture',${randomUUID()}::uuid,'policy.probe-before-first-floor','user',${f.ctx.userId!}::uuid)returning chain_seq::int as seq`)[0];}));
     await blocking(context,writerIdentity,holderIdentity,f.b.tenantId);
     // No floor write exists while the actual reader is parked before finalize.
     // Admission/profile work belongs before the intended200ms UNIQUE wait.
     expect(await ownsNativeFloorWrite(readerIdentity)).toBe(false);finalize.resolve();
     await waitRewardPolicyNativeProgress(control,receipt,context.signal,()=>ownsNativeFloorWrite(readerIdentity));
     await blocking(context,readerIdentity,writerIdentity,f.b.tenantId);
     expect((await holder`select pg_advisory_unlock(${key}::text::bigint)as released`)[0].released).toBe(true);
     expect(await command.value()).toEqual({seq:null});expect((await receipt.value()).id).toBe(receiptId);
    },async()=>{finalize.resolve();await holder`select pg_advisory_unlock_all()`;});
   });
   expect((await owner.client`select receipt_id from reward_audit_policy_private.floor_marker where tenant_id=${f.b.tenantId}::uuid`)[0].receipt_id).toBe(receiptId);
   expect((await owner.client`select count(*)::int as n from reward_audit_private.receipt where id=${receiptId!}::uuid`)[0].n).toBe(1);
   expect(roots).toHaveLength(1);await exactFrames(f.b.tenantId,before,roots);
   expect((await event(app(),f.ctx,'policy.fresh-after-transient-probe')).chain_seq).toBe(1);
  },async()=>{finalize.resolve();},()=>context.signal.removeEventListener('abort',abort));
 });
 async function bankFirstFloorRace(context:TestContext,counterexample:boolean){
  const f=await setup(),pack=requirePackFor('MY'),foreign=counterexample?await seedBase():undefined;
  // seedBase has a real global HR grant; legacy adminCtx supplies only roles.
  // Prove that the SAME live identity passes AI admission but its incomplete
  // explicit report snapshot refuses, before rebinding from native facts.
  const [rawPrincipal]=await owner.client`select tenant_id as "tenantId",person_id as "personId",grants from app.principal(${f.ctx.userId!}::uuid)`;
  const principal=z.object({tenantId:z.guid(),personId:z.guid(),grants:z.array(z.object({role:z.string(),companyId:z.guid().nullable()}).strict())}).strict().parse(rawPrincipal);
  expect(principal.tenantId).toBe(f.b.tenantId);expect(principal.personId).toBe(f.ctx.personId);expect(principal.grants).toEqual([{role:'hr_admin',companyId:null}]);expect(f.ctx.grants).toBeUndefined();
  await expect(database.withTenant(f.ctx,async tx=>{await assertAiPrincipalTx(tx,f.ctx);await assertReportPrincipalTx(tx,f.ctx);})).rejects.toBeInstanceOf(MasterReportAccessError);
  const ctx={...f.ctx,grants:principal.grants};expect(ctx.roles).toEqual(principal.grants.map(grant=>grant.role));
  await database.withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);await assertReportPrincipalTx(tx,ctx);});

  await pack.statutory.set(ctx,{personId:f.person.personId,icNumber:null,epfNumber:'FICTIONAL-RETAINED-EPF',socsoNumber:'FICTIONAL-RETAINED-SOCSO',taxNumber:'FICTIONAL-RETAINED-TAX',bankName:'Fictional legacy bank',bankAccountNo:'FLOOR-OLD'});
  await pack.statutory.setBank(ctx,{personId:f.person.personId,bankName:'Fictional legacy bank',bankAccountNo:'FLOOR-OLD',enableCustomHolderName:true,customHolderName:'Fictional old payee',enableCustomHolderId:true,customHolderId:'FICTIONAL-OLD-HOLDER'});
  const fields={bankName:pack.client.bankNames[0],bankAccountNo:'FLOOR-NEW',enableCustomHolderName:false,customHolderName:'discarded disabled name',enableCustomHolderId:false,customHolderId:'discarded disabled ID'};
  const human=Bank.Human.parse({action:Bank.action,contractVersion:1,employmentId:f.person.employmentId,subjectId:f.person.personId,fields}),prepared=(await bankMaintenanceReviews.prepare(ctx,human)).review;
  const nativeBefore=Array.from(await owner.client`select to_jsonb(s)as value from public.employee_statutory_my s where s.tenant_id=${f.b.tenantId}::uuid order by s.id`),financial=await money(f.b.tenantId);
  // Older reader establishes true BEFORE the setting writer; no setting writer
  // is attempted behind the Bank command's subsequently owned Access barrier.
  const connection=reader(),observed=deferred(),finalize=deferred(),bankEntered=deferred(),finishBank=deferred();let bankPid=0,bankStart='',receiptId:string|undefined;
  await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);
  const abort=()=>{finalize.resolve();finishBank.resolve();};context.signal.addEventListener('abort',abort,{once:true});
  const control=controlledPolicyWait(ownership.poison),receipt=control.start(()=>connection.begin('isolation level repeatable read',async tx=>{await stamp(tx,ctx);const [row]=await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`;if(typeof row.id!=='string')throw Error('Actual older armed reader required');receiptId=row.id;observed.resolve();await finalize.promise;context.signal.throwIfAborted();return(await tx`select * from reward_audit_read.finalize_read(${row.id}::uuid)`)[0];}));
  await control.run(async()=>{
   await control.ready(observed.promise,receipt,context.signal,'Actual older reader exited before native Bank PRE');await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
   const exercise=async()=>{
    const command=control.start(()=>database.withTenant(ctx,async tx=>{
     await tx.execute(sql`select app.assistant_bank_review_arm(${prepared.actionId}::uuid)`);
     if(!diagnostics)throw Error('Owned Bank test observation diagnostic required');
     const actualPre=await diagnostics.callback('bank-test-pre',()=>owned().fixture.observeReview(tx,ctx,prepared.actionId,Bank.action,context.signal,foreign?{tenantId:foreign.tenantId,userId:foreign.adminUserId}:undefined));
     const [frame]=await tx.execute<{pid:number;started:string;history:boolean}>(sql`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,exists(select 1 from pg_locks where pid=pg_backend_pid()and locktype='advisory'and granted and mode='ExclusiveLock'and objsubid=1 and classid=((hashtext(${'audit-chain:'+f.b.tenantId})::bigint>>32)&4294967295)::oid and objid=(hashtext(${'audit-chain:'+f.b.tenantId})::bigint&4294967295)::oid)as history`);
     // Derive both physical advisory-key halves natively, including sign.
     expect(frame.history).toBe(true);expect(actualPre.pre).toEqual({armed:false,priorSeq:null,priorHash:null});bankPid=frame.pid;bankStart=frame.started;bankEntered.resolve();await finishBank.promise;context.signal.throwIfAborted();
     const native=await pack.statutory.setBank(ctx,{personId:f.person.personId,...fields},tx);
     const events=await tx.execute<{id:string}>(sql`select id from public.domain_event where tenant_id=${f.b.tenantId}::uuid and aggregate_id=${native.id}::uuid and event_type='employee.bank.updated'and xmin=pg_current_xact_id()::xid`);expect(events).toHaveLength(1);
     await tx.execute(sql`select app.assistant_assigned_review_complete(${prepared.actionId}::uuid,${Bank.action},${prepared.reviewedDigest},${events[0].id}::uuid)`);return events[0].id;
    }));
    await control.run(async()=>{
     await control.ready(bankEntered.promise,command,context.signal,'Native Bank exited before real PRE witness');
     expect((await owner.client`select exists(select 1 from pg_stat_activity where pid=${bankPid} and backend_start=${bankStart}::text::timestamptz and usename='ai_hr_app')as actual`)[0].actual).toBe(true);
     finalize.resolve();expect((await receipt.value()).id).toBe(receiptId);finishBank.resolve();
     if(counterexample){control.consume(command,await refusal(command.value(),'42501'));expect(Array.from(await owner.client`select to_jsonb(s)as value from public.employee_statutory_my s where s.tenant_id=${f.b.tenantId}::uuid order by s.id`)).toEqual(nativeBefore);}
     else{
      const eventId=await command.value();expect((await owner.client`select chain_seq is null and hash is null and prev_hash is null as retained_unarmed,app._domain_event_preimage_for(e)=r.bank_audit_preimage as same_pre from public.domain_event e join app.assistant_own_leave_review r on r.receipt_event_id=e.id where e.id=${eventId}::uuid`)[0]).toEqual({retained_unarmed:true,same_pre:true});
      expect((await owner.client`select bank_account_no as account,epf_number as epf,socso_number as socso,tax_number as tax from public.employee_statutory_my where tenant_id=${f.b.tenantId}::uuid and person_id=${f.person.personId}::uuid`)[0]).toEqual({account:'FLOOR-NEW',epf:'FICTIONAL-RETAINED-EPF',socso:'FICTIONAL-RETAINED-SOCSO',tax:'FICTIONAL-RETAINED-TAX'});
     }
    },async()=>{finalize.resolve();finishBank.resolve();});
   };
   if(counterexample)await owned().fixture.withFreshFloorCounterexample(exercise);else await exercise();
   expect(await money(f.b.tenantId)).toEqual(financial);expect((await event(app(),ctx,'policy.after-bank-first-floor')).chain_seq).toBe(1);
  },async()=>{finalize.resolve();finishBank.resolve();},()=>context.signal.removeEventListener('abort',abort));
 }
 nativeIt(16,context=>bankFirstFloorRace(context,true));
 nativeIt(17,context=>bankFirstFloorRace(context,false));
 async function catalogueFirstFloorRace(context:TestContext,counterexample:boolean){
  const f=await setup(),foreign=counterexample?await seedBase():undefined,human={action:'org.position.archive' as const,contractVersion:1 as const,positionId:f.b.positionId,expectedArchived:false,archived:true};
  const prepared=(await positionArchiveReviews.prepare(f.ctx,human)).review;
  const before=Array.from(await owner.client`select to_jsonb(p)as value from public.position p where p.tenant_id=${f.b.tenantId}::uuid order by p.id`),financial=await money(f.b.tenantId);
  const connection=reader(),observed=deferred(),finalize=deferred(),entered=deferred(),finish=deferred();
  await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);
  const abort=()=>{finalize.resolve();finish.resolve();};context.signal.addEventListener('abort',abort,{once:true});
  const control=controlledPolicyWait(ownership.poison),receipt=control.start(()=>connection.begin('isolation level repeatable read',async tx=>{await stamp(tx,f.ctx);const [row]=await tx`select reward_audit_read.begin_read('libraries','salary',${f.year})as id`;observed.resolve();await finalize.promise;context.signal.throwIfAborted();return(await tx`select * from reward_audit_read.finalize_read(${row.id}::uuid)`)[0];}));
  let armedCallbacks=0;
  const actualBulk=adminOwner.bulkSaveLabels,actualSqlState=nativeErrorOwner.pgSqlState,actualErrorChain=nativeErrorOwner.pgErrorChain;
  await control.run(async()=>{
   await control.ready(observed.promise,receipt,context.signal,'Actual older read exited before Catalogue PRE');await setSetting(f.b.tenantId,'audit.hash_chain_enabled',false);
   const exercise=async()=>{
    // Transparent observation: every callback forwards unchanged arguments to
    // the real canonical owner; no owner result or authorization is fabricated.
    // admin captures pgSqlState at module initialization. Its live imported
    // pgErrorChain sees the ORIGINAL 42501 before LabelBulkError drops cause.
    const nativeSave=rewardPolicyNativeSaveObservation(actualErrorChain,actualSqlState);
    const errors=vi.spyOn(nativeErrorOwner,'pgErrorChain').mockImplementation(nativeSave.chain);
    const callback=vi.spyOn(adminOwner,'bulkSaveLabels').mockImplementation(async(...args:Parameters<typeof adminOwner.bulkSaveLabels>)=>{
     const [ctx,kind,,tx]=args;
     if(tx&&ctx.tenantId===f.b.tenantId&&kind==='position'){
      if(!diagnostics)throw Error('Owned Catalogue test observation diagnostic required');
      const actualPre=await diagnostics.callback('catalogue-test-pre',()=>owned().fixture.observeReview(tx,ctx,prepared.actionId,human.action,context.signal,foreign?{tenantId:foreign.tenantId,userId:foreign.adminUserId}:undefined));
      const [frame]=await tx.execute<{pid:number;started:string;history:boolean}>(sql`select pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,exists(select 1 from pg_locks where pid=pg_backend_pid()and locktype='advisory'and granted and mode='ExclusiveLock'and objsubid=1 and classid=((hashtext(${'audit-chain:'+f.b.tenantId})::bigint>>32)&4294967295)::oid and objid=(hashtext(${'audit-chain:'+f.b.tenantId})::bigint&4294967295)::oid)as history`);
      if(actualPre.phase==='armed'){
       armedCallbacks++;expect(armedCallbacks).toBe(1);expect(frame.history).toBe(true);expect(actualPre.pre).toEqual({armed:false,priorSeq:null,priorHash:null});
       expect((await owner.client`select exists(select 1 from pg_stat_activity where pid=${frame.pid} and backend_start=${frame.started}::text::timestamptz and usename='ai_hr_app')as actual`)[0].actual).toBe(true);
       entered.resolve();await finish.promise;context.signal.throwIfAborted();
       // Open only AFTER deliberate observer negatives and native PRE checks.
       return nativeSave.armed(()=>actualBulk(...args));
      }
     }
     return actualBulk(...args);
    });
    await control.run(async()=>{
     const command=control.start(()=>positionArchiveReviews.confirm(f.ctx,{action:human.action,contractVersion:1,actionId:prepared.actionId,reviewedDigest:prepared.reviewedDigest}));
     await control.ready(entered.promise,command,context.signal,'Actual Catalogue command exited before armed callback');
     finalize.resolve();await receipt.value();finish.resolve();
     if(counterexample){
      await expect(command.value()).rejects.toThrow();const nativeRefusals=nativeSave.knownRefusals();expect(nativeRefusals).toContainEqual({code:'42501',message:'Catalogue audit decision changed before native INSERT'});control.consume(command,await command.value().catch((error:unknown)=>error));
      expect(Array.from(await owner.client`select to_jsonb(p)as value from public.position p where p.tenant_id=${f.b.tenantId}::uuid order by p.id`)).toEqual(before);
     }else{
      expect(await command.value()).toMatchObject({kind:'completed',receipt:{receipt:{positionId:f.b.positionId,archived:true}}});
      expect((await owner.client`select p.archived_at is not null as archived,e.chain_seq is null and e.hash is null and e.prev_hash is null as retained_unarmed,app._domain_event_preimage_for(e)='{"armed":false,"priorSeq":null,"priorHash":null}'::jsonb as same_pre from public.position p join app.assistant_own_leave_review r on r.receipt_subject_id=p.id join public.domain_event e on e.id=r.receipt_event_id where r.id=${prepared.actionId}::uuid`)[0]).toEqual({archived:true,retained_unarmed:true,same_pre:true});
     }
     expect(armedCallbacks).toBe(1);expect(nativeSave.snapshot().complete).toBe(true);
    },async()=>{finalize.resolve();finish.resolve();},async()=>{await controlledPolicyWait(ownership.poison).run(async()=>{callback.mockRestore();},async()=>{errors.mockRestore();if(!diagnostics)throw Error('Owned Catalogue error diagnostic required');diagnostics.nativeSave(nativeSave.snapshot());});});
   };
   if(counterexample)await owned().fixture.withFreshFloorCounterexample(exercise);else await exercise();
   expect(await money(f.b.tenantId)).toEqual(financial);expect((await event(app(),f.ctx,'policy.after-catalogue-first-floor')).chain_seq).toBe(1);
  },async()=>{finalize.resolve();finish.resolve();},()=>context.signal.removeEventListener('abort',abort));
 }
 nativeIt(18,context=>catalogueFirstFloorRace(context,true));
 nativeIt(19,context=>catalogueFirstFloorRace(context,false));
 async function receiptProcessKill(context:TestContext,phase:'before-commit'|'after-commit'){
  const f=await setup(),financial=await money(f.b.tenantId);await setSetting(f.b.tenantId,'audit.hash_chain_enabled',true);
  const process=await rewardPolicyReaderProcess(owned().fixture,f.ctx,context.signal,controller.registerStop);
  await controlledPolicyWait(ownership.poison).run(async()=>{
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
   await controlledPolicyWait(ownership.poison).run(async()=>{
    restarted.reconcile(result.receiptId);const fresh=await restarted.wait('reconciled');if(fresh.kind!=='reconciled')throw Error('Actual restarted receipt reconciliation required');
    expect(fresh.pid!==result.pid||fresh.started!==result.started).toBe(true);
    if(phase==='before-commit')expect(fresh.value).toBeNull();else expect(fresh.value).toMatchObject({id:result.receiptId,armed:true,projected:false});
    expect(await restarted.closed).toEqual({code:0,signal:null});
   },()=>restarted.stop());
   expect((await event(app(),f.ctx,'policy.after-receipt-process-kill')).chain_seq).toBe(phase==='after-commit'?1:null);
   expect(await money(f.b.tenantId)).toEqual(financial);
  },()=>process.stop());
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
