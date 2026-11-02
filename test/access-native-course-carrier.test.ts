/** Native course crossing cannot be manufactured with caller metadata or a registry/default write. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,narrow:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const person=await hireEmployee(adminCtx(b),{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional native carrier owner',primaryEmail:randomUUID()+'@fixture.invalid'}});
 const userId=await createAppUser(b.tenantId,person.personId,'employee');
 const [other]=await owner.client`insert into company(tenant_id,legal_name) values(${b.tenantId}::uuid,'Fictional narrowed carrier') returning id`;
 narrow={...adminCtx(b),userId,personId:person.personId,roles:['employee'],grants:[{role:'employee',companyId:other.id}]};
});
it('keeps native ownership real and rejects runtime registry/default/posted-course manufacture',async()=>{
 // Owner inspection of actual native facts is independent of whether a genuine component has
 // already published this global capability in the test installation. No supported row is forged.
 const rows=await owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${narrow.userId!},true),set_config('app.roles','employee',true),set_config('app.grants',${JSON.stringify(narrow.grants)},true)`;
  return tx`select app.access_current_carrier_covers(${b.companyId}::uuid) as carrier,app.claim_own_current_native_allowed(${b.tenantId}::uuid,${narrow.userId!}::uuid,'function.claims.own.view',${b.companyId}::uuid) as native_own,app.access_current_capability_source('function.unregistered.own.view',${b.companyId}::uuid) as unknown`;
 });
 expect(rows).toEqual([{carrier:false,native_own:true,unknown:false}]);
 await expect(withTenant(narrow,tx=>tx.execute(sql`update app.access_function_definition set metadata=metadata||'{"course":"own"}'::jsonb where function_key='claims.administration'`))).rejects.toThrow();
 await expect(withTenant(narrow,tx=>tx.execute(sql`insert into app.access_native_capability_default(capability_id,parity_function,current_parity_function) values('function.claims.own.view','app.claim_own_native_allowed','app.claim_own_current_native_allowed') on conflict(capability_id) do update set current_parity_function=excluded.current_parity_function`))).rejects.toThrow();
 await expect(withTenant(narrow,async tx=>{await tx.execute(sql`select set_config('app.function_course','own',true)`);await tx.execute(sql`select app.register_function_action('unregistered.own','view','company',null,'app.claim_own_current_native_allowed','{"kind":"native_acl","course":"own","moduleKey":"claims","labelKey":"claims.title"}'::jsonb)`);})).rejects.toThrow();
 const after=await owner.client`select count(*)::int as n from app.access_function_definition where function_key='unregistered.own'`;expect(after).toEqual([{n:0}]);
});
