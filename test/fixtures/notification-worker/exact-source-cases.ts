/** Native owner-only catalogue controls + real restricted LOGIN refusal. UNINSTALLED. */
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import type {TransactionSql} from 'postgres';
import {owner} from '../../harness';
import {pgSqlState} from '../../../lib/db-error';
import {notificationWorkerLifecycle} from '../../../lib/notification-worker/lifecycle';
import type {NotificationWorkerFixtureOwner} from './owner-fixture';
const source=readFileSync('test/fixtures/notification-worker/exact-source.sql','utf8');
const rollback=Error('Controlled exact-source owner rollback');
async function rolledBack(work:(tx:TransactionSql)=>Promise<void>){
 await owner.client.begin(async tx=>{await work(tx);throw rollback;}).catch((error:unknown)=>{if(error!==rollback)throw error;});
}
async function refused(work:PromiseLike<unknown>,code:string){
 const error=await Promise.resolve(work).then(()=>null,(error:unknown)=>error);expect(pgSqlState(error)).toBe(code);return error;
}
async function currentTenant(){
 const [row]=await owner.client`select p.oid,pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)as details from pg_proc p where p.oid='app.current_tenant_id()'::regprocedure`;
 expect(row).toBeTruthy();return row;
}
async function nativeFacts(){
 return(await owner.client`select (select count(*)::int from public.job_run)as jobs,(select count(*)::int from public.notification)as notices,
  (select count(*)::int from public.notification_delivery)as deliveries,(select count(*)::int from notification_worker_private.run)as runs`)[0];
}
export async function proveExactSourceCapture(fixture:NotificationWorkerFixtureOwner,predecessors:readonly string[]){
 const before=await currentTenant();
 expect((await owner.client`select to_regnamespace('notification_worker_private')as schema`)[0].schema).toBeNull();
 await rolledBack(async tx=>{
  const b=fixture.binding;
  await tx`select set_config('aihr.notification_fixture.database',${b.database},true),set_config('aihr.notification_fixture.namespace',${b.namespace},true),set_config('aihr.notification_fixture.pool_id',${b.poolId},true)`;
  for(const prior of predecessors)await tx.unsafe(prior);
  // The actual old contract has ALREADY captured the original body. Drift now
  // must refuse instead of becoming its own newly expected canonical source.
  await tx.unsafe("CREATE OR REPLACE FUNCTION app.current_tenant_id()RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid'");
  const error=await refused(tx.unsafe(source),'55000');
  expect(error instanceof Error?error.message:'').toContain('before capture');
 });
 expect(await currentTenant()).toEqual(before);
 expect((await owner.client`select to_regnamespace('notification_worker')as worker,to_regnamespace('notification_worker_private')as private,to_regprocedure('app.notification_worker_cursor_admitted(uuid,bigint,bigint,bigint,bigint,boolean)')as cursor`)[0]).toEqual({worker:null,private:null,cursor:null});
}
export function registerExactSourceCases(fixture:NotificationWorkerFixtureOwner){
 it('captures every canonical helper exactly once and refuses activated reapplication without rebinding',async()=>{
  const [facts]=await owner.client`select count(*)::int as n,count(*)filter(where c.body_source is null or(md5(c.body_source)collate "C")is distinct from(c.body_md5 collate "C")or(c.body_source collate "C")is distinct from(p.prosrc collate "C"))::int as drift,
   sum(octet_length(c.body_source))::text as bytes from notification_worker_private.helper_contract c left join pg_proc p on p.oid=c.signature`;
  const [binary]=await owner.client`select ('é'collate "C")is distinct from(${'e\u0301'}::text collate "C")as distinct`;expect(binary.distinct).toBe(true);
  expect(facts.n).toBe(2448);expect(facts.drift).toBe(0);expect(BigInt(facts.bytes)).toBeGreaterThan(BigInt(0));
  const before=await owner.client`select signature,body_md5,md5(body_source)as captured from notification_worker_private.helper_contract order by signature::oid`;
  await rolledBack(async tx=>{const b=fixture.binding;await tx`select set_config('aihr.notification_fixture.database',${b.database},true),set_config('aihr.notification_fixture.namespace',${b.namespace},true),set_config('aihr.notification_fixture.pool_id',${b.poolId},true)`;
   const error=await refused(tx.unsafe(source),'55000');expect(error instanceof Error?error.message:'').toContain('inactive');});
  expect(await owner.client`select signature,body_md5,md5(body_source)as captured from notification_worker_private.helper_contract order by signature::oid`).toEqual(before);
  await owner.client`select notification_worker_private.assert_process_profile()`;
 });
 it('refuses committed whitespace, Unicode-byte and literal helper drift on the actual restricted LOGIN then restores exact identity',async()=>{
  const original=await currentTenant(),api=notificationWorkerLifecycle(fixture.connect()),facts=await nativeFacts();
  expect(original.definition.split(original.body)).toHaveLength(2);
  const literal=original.body.replace('app.tenant_id','app.not_the_tenant_id');expect(literal).not.toBe(original.body);
  for(const body of [original.body+'\n ',original.body+'\n-- exact-source é\n',original.body+'\n-- exact-source e\u0301\n',literal]){
   try{await owner.client.unsafe(original.definition.replace(original.body,body));await refused(api.openRun(),'42501');expect(await nativeFacts()).toEqual(facts);}
   finally{await owner.client.unsafe(original.definition);expect(await currentTenant()).toEqual(original);}
  }
  await owner.client`alter function app.current_tenant_id()set search_path=pg_catalog,public`;
  try{await refused(api.openRun(),'42501');expect(await nativeFacts()).toEqual(facts);}
  finally{await owner.client`alter function app.current_tenant_id()reset all`;expect(await currentTenant()).toEqual(original);}
  const run=await api.openRun();await api.failRun(run,'interrupted');
 });
 it('natively refuses missing and genuinely recreated helper OIDs inside owner rollback without fabricating worker LOGIN authority',async()=>{
  const [leaf]=await owner.client`select p.oid,p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid)as definition,to_jsonb(p)as details
   from notification_worker_private.helper_contract c join pg_proc p on p.oid=c.signature where p.prokind='f'and p.pronamespace='app'::regnamespace
   and p.proowner=(select relowner from pg_class where oid='public.job_run'::regclass)
   and not exists(select 1 from pg_depend d where d.refclassid='pg_proc'::regclass and d.refobjid=p.oid and d.deptype in('n','a','i','e'))order by p.oid limit 1`;
  expect(leaf).toBeTruthy();expect(leaf.signature.startsWith('app.')).toBe(true);
  for(const recreated of [false,true])await rolledBack(async tx=>{
   const [ddl]=await tx`select format('DROP FUNCTION %s',${leaf.signature}::text)as source`;await tx.unsafe(ddl.source);
   if(recreated){await tx.unsafe(leaf.definition);const [newLeaf]=await tx`select p.oid,to_jsonb(p)as details from pg_proc p where p.oid=to_regprocedure(${leaf.signature})`;expect(newLeaf.oid).not.toBe(leaf.oid);
    for(const key of ['prosrc','proowner','prolang','proconfig','prosecdef','provolatile'])expect(Reflect.get(newLeaf.details,key)).toEqual(Reflect.get(leaf.details,key));}
   await refused(tx`select notification_worker_private.assert_process_profile()`,'55000');
  });
  expect((await owner.client`select to_jsonb(p)as details from pg_proc p where p.oid=${leaf.oid}::oid`)[0].details).toEqual(leaf.details);
  await owner.client`select notification_worker_private.assert_process_profile()`;
  const api=notificationWorkerLifecycle(fixture.connect()),run=await api.openRun();await api.failRun(run,'interrupted');
 });
 it('rejects source integrity/column/CHECK tampering and keeps the real LOGIN unable to mutate canonical expectations',async()=>{
  const api=fixture.connect(),before=await owner.client`select signature,body_md5,md5(body_source)as source from notification_worker_private.helper_contract order by signature::oid`;
  await refused(api`select body_source from notification_worker_private.helper_contract`,'42501');
  await refused(api`update notification_worker_private.helper_contract set body_source='fabricated expectation'`,'42501');
  await rolledBack(async tx=>{await refused(tx`update notification_worker_private.helper_contract set body_source=body_source||' 'where signature='app.current_tenant_id()'::regprocedure`,'23514');});
  await rolledBack(async tx=>{await tx`alter table notification_worker_private.helper_contract drop constraint helper_contract_canonical_body_check`;await refused(tx`select notification_worker_private.assert_process_profile()`,'55000');});
  await rolledBack(async tx=>{await tx`alter table notification_worker_private.helper_contract alter column body_source drop not null`;await refused(tx`select notification_worker_private.assert_process_profile()`,'55000');});
  await rolledBack(async tx=>{await tx`alter table notification_worker_private.helper_contract rename column body_source to removed_source`;await refused(tx`select notification_worker_private.assert_process_profile()`,'42703');});
  expect(await owner.client`select signature,body_md5,md5(body_source)as source from notification_worker_private.helper_contract order by signature::oid`).toEqual(before);
  await owner.client`select notification_worker_private.assert_process_profile()`;
 });
}
