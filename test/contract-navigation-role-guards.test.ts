import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('avoids impossible configuration work but keeps positive Contract candidates on the full native owner',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');const admin=adminCtx(b);
 const hired=await hireEmployee(admin,{person:{fullName:'Fictional unassigned Contract viewer',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,'employee');
 const employee:SessionContext={...admin,userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const read=async(ctx:SessionContext)=>{
  const [row]=await withTenant(ctx,tx=>tx.execute<{access:{page:boolean;configure:boolean;intake:boolean}}>(sql`select app.contract_navigation_access() as access`));return row.access;
 };
 expect(await read(employee)).toEqual({page:false,configure:false,intake:false});
 expect(await read(admin)).toMatchObject({page:true,configure:true});
 const signature='app.contract_company_writable(uuid)';
 const [original]=await owner.client`select pg_get_functiondef(oid)as ddl from pg_proc where oid=${signature}::regprocedure`;
 const throwing=original.ddl.replace('LANGUAGE sql','LANGUAGE plpgsql').replace(/AS (\$[^$]*\$)[\s\S]*\1/,(_all:string,delimiter:string)=>'AS '+delimiter+" BEGIN RAISE EXCEPTION 'contract expensive source probe' USING ERRCODE='P0001'; END; "+delimiter);
 try{
  await owner.client.unsafe(throwing);
  expect(await read(employee)).toEqual({page:false,configure:false,intake:false});
  // A necessary condition never authorizes anything: the actual HR candidate still
  // reaches the complete configuration owner and propagates its source failure.
  await expect(read(admin)).rejects.toMatchObject({cause:expect.objectContaining({code:'P0001'})});
  expect(await read({...employee,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]})).toEqual({page:false,configure:false,intake:false});
 }finally{await owner.client.unsafe(original.ddl);}
 expect(await read(admin)).toMatchObject({page:true,configure:true});
 const asset=readFileSync(new URL('./performance/contract-navigation-guards.sql',import.meta.url),'utf8');
 const migration=readFileSync(new URL('../db/migrations/2104_contract_navigation_role_guards.sql',import.meta.url),'utf8');
 expect(migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'))).toBe(asset.slice(asset.indexOf('CREATE OR REPLACE FUNCTION')));
});
