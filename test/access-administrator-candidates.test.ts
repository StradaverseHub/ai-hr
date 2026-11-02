/** Actual migrated last-administrator invariant: matching groups first, live eligibility always. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();base=await seedBase();await initialize(base);});
async function initialize(b:Base){await withTenant(adminCtx(b),tx=>tx.execute(sql`select app.access_configuration_initialize()`));}
async function catalog(){const [row]=await owner.client`select to_jsonb(p) as attributes from pg_proc p where oid='app.access_assert_administrator_for(uuid)'::regprocedure`;return row.attributes;}
async function outcome(connection:any,tenantId:string){
 try{await connection.savepoint(async(tx:any)=>{await tx`select app.access_assert_administrator_for(${tenantId}::uuid)`;});return 'allowed';}
 catch(error){return (error as {code?:string}).code??String(error);}
}
async function archiveForRead(ids:string[],tenantId:string){
 const rollback=new Error('Rollback isolated archived-account fixture');let result:string|undefined;
 try{await owner.client.begin(async tx=>{await tx`update app_user set archived_at=now() where id=any(${ids}::uuid[])`;result=await outcome(tx,tenantId);throw rollback;});}
 catch(error){if(error!==rollback)throw error;}
 return result;
}
it('installs the exact measured native body and retains private execution and definer attributes',async()=>{
 const actual=await catalog();
 expect(createHash('sha256').update(actual.prosrc).digest('hex')).toBe('d2c2d60532219803bcaf17677523693d962f2a6a6828b8612d339f30f2a0ab73');
 expect(actual.prosecdef).toBe(true);expect(actual.provolatile).toBe('v');expect(actual.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
 const [authority]=await owner.client`select p.proowner=(select proowner from pg_proc where oid='app.access_assert_administrator()'::regprocedure) as same_native_owner,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute from pg_proc p where p.oid='app.access_assert_administrator_for(uuid)'::regprocedure`;
 expect(authority).toEqual({same_native_owner:true,app_execute:false});
});
it('retains every matching administrator and rechecks live archive eligibility on each invocation',async()=>{
 const spare=await createAppUser(base.tenantId,null,'hr_admin');
 expect(await archiveForRead([base.adminUserId],base.tenantId)).toBe('allowed');
 expect(await archiveForRead([spare],base.tenantId)).toBe('allowed');
 expect(await archiveForRead([base.adminUserId,spare],base.tenantId)).toBe('23514');
 expect(await owner.client.begin(tx=>outcome(tx,base.tenantId))).toBe('allowed');
});
it('never substitutes company-scoped or foreign-tenant administrators for a usable tenant administrator',async()=>{
 const local=await createAppUser(base.tenantId,null,'employee');
 await owner.db.insert(s.roleAssignment).values({tenantId:base.tenantId,appUserId:local,role:'hr_admin',companyId:base.companyId});
 const foreign=await seedBase();await initialize(foreign);
 expect(await owner.client.begin(tx=>outcome(tx,foreign.tenantId))).toBe('allowed');
 expect(await archiveForRead([base.adminUserId],base.tenantId)).toBe('23514');
 expect(await owner.client.begin(tx=>outcome(tx,base.tenantId))).toBe('allowed');
 // This storage invariant deliberately does nothing before Access initialization; it grants no caller authority.
 expect(await owner.client.begin(tx=>outcome(tx,randomUUID()))).toBe('allowed');
});
it('refuses an unexpected predecessor atomically instead of overwriting its native function',async()=>{
 const before=await catalog(),migration=readFileSync('db/migrations/0918_administrator_candidate_work.sql','utf8');
 await expect(owner.client.unsafe(migration)).rejects.toThrow('Unexpected native last-administrator predicate');
 expect(await catalog()).toEqual(before);
});
