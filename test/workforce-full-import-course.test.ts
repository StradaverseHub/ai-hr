/** Real full-workbook admission; dormant function cells are never marked supported by fixtures. */
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {pgSqlState} from '../lib/db-error';
import {commitSectionImport,validateSectionImport} from '../core/import-sections';
import {publishActionCapabilityPackage,publishWorkforceActionPackage} from '../deploy/access/publish-workforce-capabilities';
import {validateEmployeeImport} from '../core/import';
import {workforceFullImportCompanies,WorkforceAccessError} from '../core/workforce-access';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
it('keeps the actual native HR company course and refuses unsupported operations',async()=>{
 const ctx=adminCtx(b),rows=await withTenant(ctx,tx=>tx.execute<{view:boolean;add:boolean;edit:boolean}>(sql`select app.workforce_full_import_allowed(${b.companyId}::uuid,'view') as view,app.workforce_full_import_allowed(${b.companyId}::uuid,'add') as add,app.workforce_full_import_allowed(${b.companyId}::uuid,'edit') as edit`));
 expect(rows).toEqual([{view:true,add:true,edit:false}]);
 expect(await workforceFullImportCompanies(ctx)).toContain(b.companyId);
});
it('rejects forged HR claims before analyzing a workbook and exposes no import companies',async()=>{
 const userId=await createAppUser(b.tenantId,null,'employee');
 const forged:SessionContext={...adminCtx(b),userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
 expect(await workforceFullImportCompanies(forged)).toEqual([]);
 const before=await owner.client`select count(*)::integer as n from employment where tenant_id=${b.tenantId}::uuid`;
 await expect(validateEmployeeImport(forged,{companyId:b.companyId,records:[]})).rejects.toBeInstanceOf(WorkforceAccessError);
 expect(await owner.client`select count(*)::integer as n from employment where tenant_id=${b.tenantId}::uuid`).toEqual(before);
 expect(await owner.client`select id from employee_import_run where tenant_id=${b.tenantId}::uuid`).toHaveLength(0);
});

it('keeps existing-subject execution distinct from new-employee Add and closes the alternate bank-reader OID',async()=>{
 const ctx=adminCtx(b),created=await hireEmployee(ctx,{person:{fullName:'Fictional bounded bank import subject',primaryEmail:'bounded-import@fixture.invalid'},employeeCode:'IMPORT-BOUNDED',companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
 const [flags]=await withTenant(ctx,tx=>tx.execute<{view:boolean;execute:boolean;add:boolean}>(sql`select app.workforce_section_import_allowed(${b.companyId}::uuid,'view') as view,app.workforce_section_import_allowed(${b.companyId}::uuid,'execute') as execute,app.workforce_section_import_allowed(${b.companyId}::uuid,'add') as add`));
 expect(flags).toEqual({view:true,execute:true,add:false});
 const rows=await withTenant(ctx,tx=>tx.execute<{employment_id:string;full_name:string}>(sql`select employment_id,full_name from app.bank_import_subjects('["IMPORT-BOUNDED"]'::jsonb)`));
 expect(rows).toEqual([{employment_id:created.employmentId,full_name:'Fictional bounded bank import subject'}]);
 let denial:unknown;try{await withTenant(ctx,tx=>tx.execute(sql`select * from app.workforce_bank_import_subjects_native('["IMPORT-BOUNDED"]'::jsonb)`));}catch(error){denial=error;}
 expect(pgSqlState(denial)).toBe('42501');
 const userId=await createAppUser(b.tenantId,null,'employee'),employee:SessionContext={...ctx,userId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 expect(await withTenant(employee,tx=>tx.execute(sql`select * from app.bank_import_subjects('["IMPORT-BOUNDED"]'::jsonb)`))).toEqual([]);
});

it('honors an Execute denial during existing-employee apply while retaining View and full-import Add',async()=>{
 const ctx=adminCtx(b);
 await hireEmployee(ctx,{person:{fullName:'Fictional import action subject',primaryEmail:'section-execute@fixture.invalid'},employeeCode:'SECTION-EXECUTE',companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
 await publishWorkforceActionPackage(owner.client);
 const ids=['function.workforceImports.view','function.workforceImports.add','function.workforceImports.execute'];
 try{
  expect(await publishActionCapabilityPackage(owner.client,'workforce_imports')).toMatchObject({changed:true,capabilities:3});
  expect(await publishActionCapabilityPackage(owner.client,'workforce_imports')).toMatchObject({changed:false});
  const check=()=>withTenant(ctx,tx=>tx.execute(sql`select app.workforce_section_import_allowed(${b.companyId}::uuid,'view') as view,
    app.workforce_section_import_allowed(${b.companyId}::uuid,'execute') as execute,
    app.workforce_full_import_allowed(${b.companyId}::uuid,'add') as add`));
  expect(await check()).toEqual([{view:true,execute:true,add:true}]);
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,${ids[2]},${b.companyId}::uuid,'deny')`;
  expect(await check()).toEqual([{view:true,execute:false,add:true}]);
  const input={section:'qualification',records:[{employee_code:'SECTION-EXECUTE',qualification:'Bachelor'}]};
  expect((await validateSectionImport(ctx,input)).updateCount).toBe(1);
  const result=await commitSectionImport(ctx,input);
  expect(result.updated).toBe(0);
  expect(result.fileErrors.length).toBeGreaterThan(0);
  expect(await owner.client`select id from employee_qualification where tenant_id=${b.tenantId}::uuid`).toEqual([]);
 }finally{
  await owner.client`delete from app.access_native_capability_default where capability_id=any(${ids}::text[])`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${ids}::text[])`;
 }
});
