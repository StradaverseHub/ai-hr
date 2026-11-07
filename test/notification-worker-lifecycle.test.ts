/** Serialized real LOGIN lifecycle and nonempty projection prototypes; no transport or deployment. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {client} from '../db/client';
import {domainEvent,jobRun,tenantModule} from '../db/schema';
import {MODULE_CATALOG} from '../packs/catalog';
import {notificationWorkerLifecycle,NotificationProjectionUnavailable} from '../lib/notification-worker/lifecycle';
import {pgSqlState} from '../lib/db-error';
import {notificationWorkerFixtureDatabase} from './fixtures/notification-worker/database';
import {workerDb} from './db-names';
import {owner,resetDb,seedBase,type Base} from './harness';
import {notificationWorkerFixtureOwner} from './fixtures/notification-worker/owner-fixture';
import {registerNotificationProjectionCases} from './fixtures/notification-worker/projection-cases';
// A single test file and explicit sequential suites own this one cluster LOGIN.
const fixtureOwner=notificationWorkerFixtureOwner();
describe.sequential('native notification worker capabilities',()=>{
beforeAll(()=>fixtureOwner.setup(),300000);
afterAll(()=>fixtureOwner.close());
describe.sequential('native notification lifecycle authority (stage1)',()=>{
const role='ai_hr_notification_worker',fixture=readFileSync('test/fixtures/notification-worker/lifecycle.sql','utf8');
let binding:ReturnType<typeof notificationWorkerFixtureDatabase>;
const gateStart=fixture.indexOf('DO $gate$');
if(gateStart<1)throw Error('Canonical notification fixture database guard is missing');
const databaseGuard=fixture.slice(0,gateStart);
beforeAll(async()=>{binding=fixtureOwner.binding;await fixtureOwner.install([fixture],1);},300000);
beforeEach(async()=>{
 await owner.client`truncate notification_worker_private.run cascade`;
 await owner.client`update notification_worker_private.authority set active_run=null,enabled=true,max_run_batches=10`;
 await resetDb();b=await seedBase();foreign=await seedBase();
 await owner.db.delete(tenantModule).where(eq(tenantModule.moduleCode,'notifications'));
 await owner.db.insert(tenantModule).values([{tenantId:b.tenantId,moduleCode:'notifications'},{tenantId:foreign.tenantId,moduleCode:'notifications',companyId:foreign.companyId}]);
 // Isolate each case's explicit source intents from setup-only historical events.
 await owner.client`update public.notification_event_processing set disposition='legacy-cursor',processed_at=now()`;
 service=connect();other=connect();
 const [actual]=await service`select session_user,current_user,pg_backend_pid() as pid`;
 expect(actual.session_user).toBe(role);expect(actual.current_user).toBe(role);
});
afterEach(()=>fixtureOwner.finishCase());
afterAll(()=>fixtureOwner.clearStage());
async function sourceFacts(){
 const counts=await owner.client`select (select count(*) from public.notification) as notifications,(select count(*) from public.notification_delivery) as deliveries,
 (select count(*) from public.domain_event) as events,(select count(*) from public.employment) as employees,(select count(*) from public.person) as people,
 (select count(*) from public.role_assignment) as roles,(select count(*) from public.payslip) as payslips,
 (select coalesce(jsonb_agg(to_jsonb(p) order by p.event_id,p.consumer),'[]') from public.notification_event_processing p) as receipts,
 (select coalesce(jsonb_agg(to_jsonb(c) order by c.tenant_id),'[]') from public.notification_cursor c) as cursors`;
 // Hash every column, not just row counts: an unauthorized UPDATE must not hide
 // behind a stable population. These fixed fictional tables are never API input.
 const tables=['person','employment','app_user','role_assignment','payroll_batch','payslip','leave_ledger','claim_request','tenant_module','tenant_setting','domain_event','notification','notification_delivery','notification_event_processing','notification_cursor','hr_orchestration_case','letter_job','performance_onehr_review'];
 const hashes=await owner.client.unsafe(tables.map(table=>`select '${table}' as name,md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb)::text) as digest from public.${table} r`).join(' union all '));
 return [{...counts[0],hashes}];
}
async function event(base=b){
 const [e]=await owner.db.insert(domainEvent).values({tenantId:base.tenantId,aggregateType:'fixture',aggregateId:randomUUID(),eventType:'fixture.worker-read',actorType:'system',payload:{fictional:true}}).returning();return e;
}
it('binds both URLs to the actual canonical hosted worker, rejecting production/shared/sibling targets',()=>{
 expect(binding.database).toBe(workerDb(binding.poolId));
 expect(binding.database).toBe('ai_hr_test_w'+(binding.namespace?(binding.namespace.startsWith('_')?binding.namespace:'_'+binding.namespace):'')+binding.poolId);
 for(const path of ['/ai_hr','/ai_hr_staging','/ai_hr_test_tpl','/'+workerDb(Number(binding.poolId)+1),'/ai_hr_test_w1_wrong']){
  const target=new URL(binding.migrationUrl);target.pathname=path;
  expect(()=>notificationWorkerFixtureDatabase(target.toString())).toThrow('exact loopback canonical worker database');
  expect(()=>notificationWorkerFixtureDatabase(undefined,target.toString())).toThrow('exact loopback canonical worker database');
 }
 for(const host of ['localhost','production.example.invalid','[::1]']){const target=new URL(binding.migrationUrl);target.hostname=host;expect(()=>notificationWorkerFixtureDatabase(target.toString())).toThrow();}
 for(const query of ['?host=production.example.invalid','?database=ai_hr','?options=-crole=ai_hr_app']){const target=new URL(binding.migrationUrl);target.search=query;expect(()=>notificationWorkerFixtureDatabase(target.toString())).toThrow();}
});
it('executes the exact SQL database guard positively and refuses altered/missing canonical bindings independently of existing schemas',async()=>{
 await owner.client.begin(async tx=>{
  await tx`select set_config('aihr.notification_fixture.database',${binding.database},true),set_config('aihr.notification_fixture.namespace',${binding.namespace},true),set_config('aihr.notification_fixture.pool_id',${binding.poolId},true)`;
  await tx.unsafe(databaseGuard);
 });
 for(const wrong of [
  {database:'ai_hr',namespace:binding.namespace,poolId:binding.poolId},
  {database:binding.database,namespace:binding.namespace==='wrong_namespace'?'other_namespace':'wrong_namespace',poolId:binding.poolId},
  {database:binding.database,namespace:'_',poolId:binding.poolId},
  {database:binding.database,namespace:'x'.repeat(21),poolId:binding.poolId},
  {database:binding.database,namespace:binding.namespace,poolId:'0'},
  {database:binding.database,namespace:binding.namespace,poolId:''},
  {database:'',namespace:binding.namespace,poolId:binding.poolId},
 ])await expect(owner.client.begin(async tx=>{
  await tx`select set_config('aihr.notification_fixture.database',${wrong.database},true),set_config('aihr.notification_fixture.namespace',${wrong.namespace},true),set_config('aihr.notification_fixture.pool_id',${wrong.poolId},true)`;
  await tx.unsafe(databaseGuard);
 })).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='55000');
});
it('pins the unchanged native module upper bound to the canonical catalog',()=>{
 const item=MODULE_CATALOG.find(row=>row.code==='notifications');expect(item).toMatchObject({dependsOn:[],isCore:false,parentModule:null});
});
it('uses real run/scope/empty-batch lifecycle and exact terminal CAS without source effects',async()=>{
 const before=await sourceFacts(),api=notificationWorkerLifecycle(service),run=await api.openRun(),scope=await api.scopePage(run);
 expect((await owner.client`select count(*)::int as n from pg_stat_activity where usename=${role}`)[0].n).toBe(1);
 expect(scope.map(row=>row.tenant_id).sort()).toEqual([b.tenantId,foreign.tenantId].sort());
 expect(scope.find(row=>row.tenant_id===b.tenantId)?.consumer).toBe('notifications');expect(scope.find(row=>row.tenant_id===foreign.tenantId)?.consumer).toBe('assessment-reminders');
 await expect(api.openRun()).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');
 // Seed emits events. This owner-only fixture marks existing intents as historical,
 // independently of the worker, to exercise a genuinely empty lifecycle.
 await owner.client`update public.notification_event_processing set disposition='legacy-cursor',processed_at=now()`;
 const emptyBefore=await sourceFacts(),rollback=Error('Rollback empty native settlement');
 await expect(service.begin(async tx=>{
  const [opened]=await tx`select notification_worker.open_batch(${run}::uuid,${b.tenantId}::uuid,25) as id`;
  await tx`select * from notification_worker.finish_batch(${opened.id}::uuid)`;throw rollback;
 })).rejects.toBe(rollback);
 expect((await owner.client`select committed_batches from notification_worker_private.run where run_id=${run}::uuid`)[0].committed_batches).toBe(0);
 expect(await api.finishEmptyBatch(run,b.tenantId,25)).toEqual({processed:0,created:0});
 for(const row of scope)expect((await api.settleScope(run,row.tenant_id,'drained')).pending).toBe('0');
 await api.finishRun(run);const [record]=await owner.db.select().from(jobRun).where(eq(jobRun.id,run));
 expect(record).toMatchObject({jobKey:'notifications.project',outcome:'success',tenantsProcessed:2,tenantsFailed:0,result:{batches:1,processed:0,created:0}});
 await expect(api.finishRun(run)).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');expect(await sourceFacts()).toEqual(emptyBefore);
 expect(before[0].employees).toBe(emptyBefore[0].employees);
});
it('binds nonempty events to exact backend/transaction/tenant and refuses fabricated completion',async()=>{
 const e=await event(),alien=await event(foreign),api=notificationWorkerLifecycle(service),run=await api.openRun(),before=await sourceFacts();
 const rollback=Error('Controlled batch rollback');let batch='';
 await expect(service.begin(async tx=>{
  await tx`create temporary table authority(login_oid oid,enabled boolean)`;
  await tx`insert into authority values(0,true)`;
  await tx`set local search_path=pg_temp,public`;
  await tx`select set_config('app.tenant_id',${foreign.tenantId},true),set_config('app.user_id',${foreign.adminUserId},true),set_config('app.roles','super_admin',true),set_config('app.grants','[{"role":"super_admin","companyId":null}]',true),set_config('app.agent_principal_id','',true)`;
  const [opened]=await tx`select notification_worker.open_batch(${run}::uuid,${b.tenantId}::uuid,25) as id`;batch=opened.id;
  const events=await tx`select * from notification_worker.events(${batch}::uuid)`;expect(events.some(row=>row.event_id===e.id)).toBe(true);expect(events.some(row=>row.event_id===alien.id)).toBe(false);
  throw rollback;
 })).rejects.toBe(rollback);
 await expect(service`select * from notification_worker.events(${batch}::uuid)`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 await expect(api.finishEmptyBatch(run,b.tenantId,25)).rejects.toBeInstanceOf(NotificationProjectionUnavailable);
 await expect(other`select * from notification_worker.scope_page(${run}::uuid,null,25)`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 await expect(service.begin('isolation level repeatable read',tx=>tx`select * from notification_worker.scope_page(${run}::uuid,null,25)`)).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 await expect(service`select notification_worker.finish_run(${run}::uuid)`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');
 expect(await sourceFacts()).toEqual(before);await api.failRun(run,'projection-unimplemented');
});
it('inspects actual PUBLIC/inherited access and only the eight explicit definer capabilities',async()=>{
 const [profile]=await owner.client`select
  exists(select 1 from pg_namespace n where n.nspname in('app','identity_email','notification_worker_private') and has_schema_privilege(${role},n.oid,'USAGE')) as sensitive_usage,
  exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=${role}) or roleid=(select oid from pg_roles where rolname=${role})) as memberships,
  has_database_privilege(${role},current_database(),'CREATE') as database_create,
  exists(select 1 from pg_namespace n where n.nspname !~ '^pg_' and has_schema_privilege(${role},n.oid,'CREATE')) as schema_create,
  exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind in('r','p','v','m','f')
   and (has_table_privilege(${role},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(${role},c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) as source_access`;
 expect(profile).toEqual({sensitive_usage:false,memberships:false,database_create:false,schema_create:false,source_access:false});
 const functions=await owner.client`select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where p.prosecdef and n.nspname !~ '^pg_' and has_schema_privilege(${role},n.oid,'USAGE') and has_function_privilege(${role},p.oid,'EXECUTE') order by signature`;
 expect(functions.map(row=>row.signature)).toEqual([
  'notification_worker.events(uuid)','notification_worker.fail_run(uuid,text)','notification_worker.finish_batch(uuid)',
  'notification_worker.finish_run(uuid)','notification_worker.open_batch(uuid,uuid,integer)','notification_worker.open_run()',
  'notification_worker.scope_page(uuid,uuid,integer)','notification_worker.settle_scope(uuid,uuid,text)',
 ]);
});
it('admits still-pending late sequence allocations behind the legacy cursor without fabricating a disposition',async()=>{
 const [reserved]=await owner.client`select nextval(pg_get_serial_sequence('public.domain_event','sequence'))::text as n`;
 const newer=await event();
 await owner.client`insert into public.notification_cursor(tenant_id,last_sequence) values(${b.tenantId}::uuid,${newer.sequence}) on conflict(tenant_id) do update set last_sequence=excluded.last_sequence`;
 const [late]=await owner.db.insert(domainEvent).values({tenantId:b.tenantId,aggregateType:'fixture',aggregateId:randomUUID(),eventType:'fixture.late-allocation',actorType:'system',sequence:Number(reserved.n)}).returning();
 const api=notificationWorkerLifecycle(service),run=await api.openRun(),before=await sourceFacts(),rollback=Error('Keep projection pending');
 await expect(service.begin(async tx=>{
  const [batch]=await tx`select notification_worker.open_batch(${run}::uuid,${b.tenantId}::uuid,25) as id`;
  const events=await tx`select * from notification_worker.events(${batch.id}::uuid)`;
  expect(events.map(row=>row.event_id)).toEqual([late.id,newer.id]);
  expect(BigInt(reserved.n)).toBeLessThan(BigInt(newer.sequence));throw rollback;
 })).rejects.toBe(rollback);
 expect(await sourceFacts()).toEqual(before);await api.failRun(run,'projection-unimplemented');
});
it('refuses committing unfinished batches, stale transaction IDs, reconnects, changed scope and count overflow',async()=>{
 const api=notificationWorkerLifecycle(service),run=await api.openRun();let batch='';
 const [unrelated]=await owner.db.insert(jobRun).values({jobKey:'fixture.unrelated-job',outcome:'running'}).returning();
 ownedJobs.add(unrelated.id);
 await expect(api.failRun(unrelated.id,'database-refusal')).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 expect((await owner.db.select().from(jobRun).where(eq(jobRun.id,unrelated.id)))[0]).toEqual(unrelated);
 const before=await sourceFacts();
 await expect(service.begin(async tx=>{batch=(await tx`select notification_worker.open_batch(${run}::uuid,${b.tenantId}::uuid,25) as id`)[0].id;})).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');
 await expect(service`select * from notification_worker.events(${batch}::uuid)`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 expect(await sourceFacts()).toEqual(before);
 for(const count of [0,26])await expect(service`select notification_worker.open_batch(${run}::uuid,${b.tenantId}::uuid,${count})`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='54000');
 await expect(service`select notification_worker.open_batch(${run}::uuid,${randomUUID()}::uuid,25)`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 await owner.db.delete(tenantModule).where(eq(tenantModule.tenantId,b.tenantId));
 await expect(service`select notification_worker.open_batch(${run}::uuid,${b.tenantId}::uuid,25)`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 await service.end({timeout:0});const reconnected=connect();
 await expect(reconnected`select * from notification_worker.scope_page(${run}::uuid,null,25)`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 await expect(reconnected`select notification_worker.open_run()`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');
});
it('denies native source/DDL/role/helper writes under forged contexts inside and outside admission',async()=>{
 await event();
 const run=await notificationWorkerLifecycle(service).openRun(),before=await sourceFacts();
 const attempts=[
  'set role ai_hr_app','set role postgres','set session authorization ai_hr_app','grant ai_hr_app to ai_hr_notification_worker',"set local session_replication_role='replica'",
  'create table public.worker_intrusion(id integer)','create schema worker_intrusion',
  'select * from notification_worker_private.authority','select app.current_tenant_id()',
  "insert into public.person(tenant_id,full_name,primary_email) values('"+b.tenantId+"','intrusion','intrusion@example.invalid')",
  'update public.employment set employee_code=employee_code','delete from public.role_assignment',
  'delete from public.app_user','delete from public.claim_request','delete from public.tenant_setting',
  'delete from public.hr_orchestration_case','delete from public.letter_job','delete from public.performance_onehr_review',
  'update public.payroll_batch set needs_recalc_at=now()','delete from public.payslip','delete from public.leave_ledger',
  "update public.job_run set outcome='success'",'delete from public.domain_event','delete from public.tenant_module',
  'delete from public.notification','delete from public.notification_delivery','delete from public.notification_event_processing','delete from public.notification_cursor',
 ];
 for(const admitted of [false,true])for(const command of attempts){
  let refusal:unknown;try{await service.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${b.adminUserId},true),set_config('app.roles','super_admin',true),set_config('app.grants','[{"role":"super_admin","companyId":null}]',true)`;
   if(admitted)await tx`select notification_worker.open_batch(${run}::uuid,${b.tenantId}::uuid,25)`;
   await tx.unsafe(command);throw Error('Unexpected native capability escape');
  });}catch(error){refusal=error;}
  expect(pgSqlState(refusal),command).toBe('42501');
 }
 await expect(client`select notification_worker.open_run()`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 expect(await sourceFacts()).toEqual(before);await notificationWorkerLifecycle(service).failRun(run,'database-refusal');
});
it('fails closed on new PUBLIC definer privileges and changed real login/profile/bounds',async()=>{
 const before=await sourceFacts();
 await owner.client`create function public.fictional_worker_mutator() returns void language sql security definer as 'delete from public.notification'`;
 try{await expect(service`select notification_worker.open_run()`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');}finally{await owner.client`drop function public.fictional_worker_mutator()`;}
 await owner.client`alter role ai_hr_notification_worker inherit`;
 try{await expect(service`select notification_worker.open_run()`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');}finally{await owner.client`alter role ai_hr_notification_worker noinherit`;}
 await owner.client`update notification_worker_private.authority set login_oid=0`;
 try{await expect(service`select notification_worker.open_run()`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');}finally{await owner.client`update notification_worker_private.authority set login_oid=(select oid from pg_roles where rolname=${role})`;}
 const api=notificationWorkerLifecycle(service),run=await api.openRun();await owner.client`update notification_worker_private.authority set max_run_batches=1`;
 await owner.client`update public.notification_event_processing set disposition='legacy-cursor',processed_at=now()`;
 const emptyBefore=await sourceFacts();await api.finishEmptyBatch(run,b.tenantId,25);
 await expect(api.finishEmptyBatch(run,b.tenantId,25)).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='54000');
 await api.failRun(run,'budget-exhausted');expect(await sourceFacts()).toEqual(emptyBefore);expect(before[0].people).toBe(emptyBefore[0].people);
});

});
registerNotificationProjectionCases(fixtureOwner);

});
