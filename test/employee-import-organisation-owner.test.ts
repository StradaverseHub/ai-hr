import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {validateEmployeeImport,commitEmployeeImport} from '../core/import';
import {assignmentHistory} from '../core/read';
import {listAllProfileOptions} from '../core/profile-options';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{await resetDb();base=await seedBase();});
afterAll(async()=>{await closeAll();});
it('prefers the department code over another label, preserves legacy BU/grade labels and shows the saved owner rename',async()=>{
 const [unit]=await owner.db.insert(s.businessUnit).values({tenantId:base.tenantId,companyId:base.companyId,code:'BU-ORG',name:'Unit description',label:'Readable business unit'}).returning();
 const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:base.tenantId,code:'GRADE-ORG',name:'Readable grade'}).returning();
 await owner.db.update(s.department).set({name:'DP0001',label:'GREEN INTEGRATED BASE STABILISER',businessUnitId:unit.id}).where(eq(s.department.id,base.deptA));
 // The same text is another department's code. The exact code wins over the label alias.
 await owner.db.update(s.department).set({name:'GREEN INTEGRATED BASE STABILISER',label:'Different department'}).where(eq(s.department.id,base.deptB));
 const records=[{employee_code:'ORG-IMPORT',full_name:'Fictional org import',email:'org-import@fixture.test',department:'  green integrated base stabiliser ',business_unit:' readable business unit ',job_grade:' readable grade ',hired_on:todayInKualaLumpur(),ic_number:'910505051234',basic_salary:'3000'}];
 const ctx=adminCtx(base);
 const preview=await validateEmployeeImport(ctx,{companyId:base.companyId,records});
 expect(preview.rows[0].errors).toEqual([]);
 expect(preview.rows[0].proposed).toContainEqual({column:'department',value:'green integrated base stabiliser → Different department (GREEN INTEGRATED BASE STABILISER)'});
 const result=await commitEmployeeImport(ctx,{companyId:base.companyId,records});
 expect(result.imported).toBe(1);expect(result.failed).toEqual([]);
 const [employee]=await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId,base.tenantId),eq(s.employment.employeeCode,'ORG-IMPORT')));
 expect(employee.gradeId).toBe(grade.id);
 const placements=await owner.db.select().from(s.assignment).where(and(eq(s.assignment.employmentId,employee.id),isNull(s.assignment.supersededAt))).orderBy(s.assignment.validFrom,s.assignment.id);
 expect(placements).toHaveLength(1);expect(placements[0]).toMatchObject({departmentId:base.deptB,businessUnitId:unit.id,validFrom:records[0].hired_on});
 await owner.db.update(s.department).set({label:'Renamed department'}).where(eq(s.department.id,base.deptB));
 expect((await assignmentHistory(ctx,employee.id))[0].department).toBe('Renamed department');
});
it('rechecks active grade availability at confirmation rather than accepting the earlier preview',async()=>{
 const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:base.tenantId,code:'GRADE-STALE',name:'Grade that retires'}).returning();
 const ctx=adminCtx(base),records=[{employee_code:'STALE-ORG',full_name:'Fictional stale grade',email:'stale-org@fixture.test',department:'Finance',job_grade:'Grade that retires',hired_on:todayInKualaLumpur(),ic_number:'920505051234',basic_salary:'3000'}];
 expect((await validateEmployeeImport(ctx,{companyId:base.companyId,records})).rows[0].errors).toEqual([]);
 await owner.db.update(s.jobGrade).set({archivedAt:new Date()}).where(eq(s.jobGrade.id,grade.id));
 expect((await commitEmployeeImport(ctx,{companyId:base.companyId,records})).imported).toBe(0);
 const saved=await owner.db.select({id:s.employment.id}).from(s.employment).where(and(eq(s.employment.tenantId,base.tenantId),eq(s.employment.employeeCode,'STALE-ORG')));
 expect(saved).toEqual([]);
});

it('Category code beats another label at full import and a rename retains the saved canonical code',async()=>{
 const [labelOwner]=await owner.db.insert(s.profileOption).values({tenantId:base.tenantId,category:'category',value:'CAT-A',label:'Shared',isActive:true}).returning();
 const [codeOwner]=await owner.db.insert(s.profileOption).values({tenantId:base.tenantId,category:'category',value:'Shared',label:'Other',isActive:true}).returning();
 const ctx=adminCtx(base),records=[{employee_code:'CATEGORY-IMPORT',full_name:'Fictional category import',email:'category-import@fixture.test',department:'Finance',employment_category:' shared ',hired_on:todayInKualaLumpur(),ic_number:'930505051234',basic_salary:'3000'}];
 const preview=await validateEmployeeImport(ctx,{companyId:base.companyId,records});
 expect(preview.rows[0].errors).toEqual([]);
 expect(preview.rows[0].proposed).toContainEqual({column:'employment_category',value:'shared → Other (Shared)'});
 expect((await commitEmployeeImport(ctx,{companyId:base.companyId,records})).imported).toBe(1);
 const [saved]=await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId,base.tenantId),eq(s.employment.employeeCode,'CATEGORY-IMPORT')));
 expect(saved.employmentCategory).toBe('Shared');
 await owner.db.update(s.profileOption).set({label:'Renamed category'}).where(eq(s.profileOption.id,codeOwner.id));
 const fresh=await listAllProfileOptions(ctx,{activeOnly:true});
 expect(fresh.category.find(option=>option.value===saved.employmentCategory)?.label).toBe('Renamed category');
 const [unchanged]=await owner.db.select({code:s.employment.employmentCategory}).from(s.employment).where(eq(s.employment.id,saved.id));
 expect(unchanged.code).toBe('Shared');
});


it('keeps the Employee Import owner’s timeout through deferred checks and rolls back a refused file',async()=>{
 const ctx=adminCtx(base),companyId=base.companyId;
 const [setting]=await withTenant(ctx,tx=>tx.execute<{milliseconds:number}>(sql`
  select setting::int as milliseconds from pg_catalog.pg_settings where name='statement_timeout'
 `));
 const timeout=setting.milliseconds;
 if(!Number.isSafeInteger(timeout)||timeout<0)throw Error('Invalid fictional database timeout');
 const records=['TIMEOUT-IMPORT-OK','TIMEOUT-IMPORT-FIRST','TIMEOUT-IMPORT-REFUSED'].map((code,index)=>({
  employee_code:code,full_name:`Fictional timeout import ${index}`,email:`timeout-import-${index}@fixture.test`,
  department:'Finance',hired_on:todayInKualaLumpur(),ic_number:`${91+index}0505051234`,basic_salary:'3000',
 }));
 const completed=()=>owner.db.select({id:s.domainEvent.id}).from(s.domainEvent).where(and(
  eq(s.domainEvent.tenantId,base.tenantId),eq(s.domainEvent.aggregateId,companyId),eq(s.domainEvent.eventType,'employee-import.completed'),
 ));
 try{
  // Only the three fictional test employees can enter the deferred observer. The interpolated value is a checked integer.
  await owner.client.unsafe(`create function public.fixture_employee_import_timeout() returns trigger language plpgsql as $$
   begin
    if (select setting::int from pg_catalog.pg_settings where name='statement_timeout') <> ${timeout} then
     raise exception 'Fictional Employee Import changed the caller statement timeout';
    end if;
    if new.employee_code='TIMEOUT-IMPORT-REFUSED' then raise exception 'Fictional Employee Import deferred refusal'; end if;
    return null;
   end $$`);
  await owner.client.unsafe(`create constraint trigger fixture_employee_import_timeout after insert on public.employment
   deferrable initially deferred for each row when (new.employee_code in ('TIMEOUT-IMPORT-OK','TIMEOUT-IMPORT-FIRST','TIMEOUT-IMPORT-REFUSED'))
   execute function public.fixture_employee_import_timeout()`);
  const accepted=await commitEmployeeImport(ctx,{companyId,records:records.slice(0,1)});
  expect(accepted).toMatchObject({imported:1,failed:[],fileErrors:[]});
  expect(await completed()).toHaveLength(1);
  const remaining=records.slice(1);
  const preview=await validateEmployeeImport(ctx,{companyId,records:remaining});
  expect(preview.rows.map(row=>row.errors)).toEqual([[],[]]);
  expect(preview.fileErrors).toEqual([]);
  const refused=await commitEmployeeImport(ctx,{companyId,records:remaining});
  expect(refused.imported).toBe(0);
  expect(refused.failed).toHaveLength(2);
  const stored=await owner.db.select({code:s.employment.employeeCode}).from(s.employment).where(and(
   eq(s.employment.tenantId,base.tenantId),inArray(s.employment.employeeCode,records.map(row=>row.employee_code)),
  ));
  expect(stored).toEqual([{code:records[0].employee_code}]);
  expect(await completed()).toHaveLength(1);
 }finally{
  await owner.client.unsafe('drop trigger if exists fixture_employee_import_timeout on public.employment');
  await owner.client.unsafe('drop function if exists public.fixture_employee_import_timeout()');
 }
});
