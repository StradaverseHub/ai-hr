import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const append=()=>withTenant(adminCtx(b),tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'ordering-fixture',aggregateId:randomUUID(),eventType:'ordering-fixture.checked',actor:actorOf(adminCtx(b)),payload:{}}));
it('joins Access before the audit head for a genuine native append and retains both through COMMIT',async()=>{
 await withTenant(adminCtx(b),async tx=>{
  await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'ordering-fixture',aggregateId:randomUUID(),eventType:'ordering-fixture.checked',actor:actorOf(adminCtx(b)),payload:{}});
  const [locks]=await owner.db.execute<{access:boolean;audit:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0)) access,pg_try_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId})) audit`);
  expect(locks).toEqual({access:false,audit:false});
 });
 await append();
});
it('fails before taking audit under Access contention, leaves no orphan event, and succeeds on retry',async()=>{
 const [before]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid`);
 await owner.db.transaction(async held=>{
  await held.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);
  let error:unknown;try{await append();}catch(e){error=e;}expect(pgSqlState(error)).toBe('55P03');
  const [audit]=await owner.db.execute<{ok:boolean}>(sql`select pg_try_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId})) ok`);expect(audit.ok).toBe(true);
  const [after]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid`);expect(after.n).toBe(before.n);
 });
 await append();
 const [after]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where tenant_id=${b.tenantId}::uuid`);expect(after.n).toBe(before.n+1);
});
it('uses the actual event tenant for an owner append without a session claim',async()=>{
 const other=await seedBase();
 await owner.db.transaction(async held=>{
  await held.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+other.tenantId},0))`);
  let error:unknown;try{await owner.db.execute(sql`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload) values(${other.tenantId}::uuid,'ordering-fixture',${randomUUID()}::uuid,'ordering-fixture.system','system','{}'::jsonb)`);}catch(e){error=e;}
  expect(pgSqlState(error)).toBe('55P03');
  await append(); // an unrelated tenant remains independent
 });
});
it('keeps all ordering entry helpers private and cannot turn them into a runtime authority port',async()=>{
 for(const signature of ['app.audit_access_order_lock_for(uuid)','app.audit_access_order_lock()','app.audit_access_order_event()']){
  const [row]=await owner.db.execute<{app:boolean;public:boolean}>(sql`select has_function_privilege('ai_hr_app',${signature},'EXECUTE') app,exists(select 1 from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=${signature}::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') public`);
  expect(row).toEqual({app:false,public:false});
 }
});
