/** Shared foundation only: no unpublished Attendance/Home feature is required by this contract. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {appUser,company,person,roleAssignment} from '../db/schema';
import {closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();});
async function principal(role:'employee'|'hr_admin'='employee'){
 const [subject]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional principal proof subject'}).returning({id:person.id});
 const userId=await createAppUser(b.tenantId,subject.id,role);
 if(role==='hr_admin')await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,userId));
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:subject.id,roles:[role],grants:[{role,companyId:role==='hr_admin'?b.companyId:null}]};
 return {ctx,userId,personId:subject.id};
}
async function proof(ctx:SessionContext){
 const [row]=await withTenant(ctx,tx=>tx.execute<{valid:boolean}>(sql`select app.principal_snapshot_current() as valid`));
 return row.valid;
}
describe('canonical current principal snapshot foundation',()=>{
 it('admits real current employee and scoped administrator snapshots, including a narrower descendant grant',async()=>{
  const employee=await principal(),hr=await principal('hr_admin');
  expect(await proof(employee.ctx)).toBe(true);expect(await proof(hr.ctx)).toBe(true);
  const [child]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional child scope',parentCompanyId:b.companyId}).returning({id:company.id});
  expect(await proof({...hr.ctx,grants:[{role:'hr_admin',companyId:child.id}]})).toBe(true);
 });
 it('refuses forged roles, expanded company grants, missing identity and an actual different tenant',async()=>{
  const employee=await principal(),hr=await principal('hr_admin'),foreign=await seedBase();
  const [unrelated]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional unrelated scope'}).returning({id:company.id});
  expect(await proof({...employee.ctx,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]})).toBe(false);
  expect(await proof({...hr.ctx,grants:[{role:'hr_admin',companyId:null}]})).toBe(false);
  expect(await proof({...hr.ctx,grants:[{role:'hr_admin',companyId:unrelated.id}]})).toBe(false);
  expect(await proof({tenantId:b.tenantId,roles:[]})).toBe(false);
  expect(await proof({...employee.ctx,tenantId:foreign.tenantId})).toBe(false);
 });
 it('rejects an existing snapshot after actual role revocation or actual login archival',async()=>{
  const hr=await principal('hr_admin');expect(await proof(hr.ctx)).toBe(true);
  await owner.db.update(roleAssignment).set({role:'employee'}).where(eq(roleAssignment.appUserId,hr.userId));
  expect(await proof(hr.ctx)).toBe(false);
  const employee=await principal();expect(await proof(employee.ctx)).toBe(true);
  await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,employee.userId));
  expect(await proof(employee.ctx)).toBe(false);
 });
 it('keeps supplied Person binding separate from principal role and grant freshness',async()=>{
  const employee=await principal(),other=await principal();
  const [own]=await withTenant(employee.ctx,tx=>tx.execute<{current:boolean;own:boolean}>(sql`select app.principal_snapshot_current() as current,app.is_self_person(${employee.personId}::uuid) as own`));
  expect(own).toEqual({current:true,own:true});
  const [substituted]=await withTenant({...employee.ctx,personId:other.personId},tx=>tx.execute<{current:boolean;own:boolean}>(sql`select app.principal_snapshot_current() as current,app.is_self_person(${other.personId}::uuid) as own`));
  expect(substituted).toEqual({current:true,own:false});
 });
 it('grants only the runtime execute seam rather than public execute',async()=>{
  const [row]=await owner.db.execute<{definer:boolean;stable:boolean;runtime:boolean;public_execute:boolean}>(sql`
   select p.prosecdef as definer,p.provolatile='s' as stable,
    has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as runtime,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
   from pg_proc p where p.oid='app.principal_snapshot_current()'::regprocedure`);
  expect(row).toEqual({definer:true,stable:true,runtime:true,public_execute:false});
 });
});
