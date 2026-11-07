import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {hireEmployee,setEmploymentAssignment} from '../core/org';
import {readPersonnelOverview} from '../core/read';
import {todayInKualaLumpur} from '../lib/hr-date';
import {seedPersonnelCorrectionFixture} from './performance/personnel-native-fixture';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';

const migration=readFileSync(new URL('../db/migrations/2701_personnel_typed_overview_filter_fields.sql',import.meta.url),'utf8');
const typed='app.personnel_overview_filter_fields(date,uuid[])';
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(resetDb);
const normalize=(value:Awaited<ReturnType<typeof readPersonnelOverview>>)=>({...value,organisationChoices:{...value.organisationChoices,rows:value.organisationChoices.rows.map(row=>JSON.stringify(row)).sort()}});

it('retains exact full DTOs, independently expected pages/facets and native dated-company facts',async()=>{
 const base=await seedBase(),foreign=await seedBase(),ctx={...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]};
 const hire=(name:string,code:string)=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01',employeeCode:code});
 const first=await hire('Fictional Alpha','TYPED-01'),second=await hire('Fictional Beta','TYPED-02');
 await setEmploymentAssignment(ctx,{employmentId:second.employmentId,effectiveDate:'2099-01-01',departmentId:base.deptB});
 for(const [extra,expected,total] of [
  [{},[first.employmentId,second.employmentId],2],
  [{q:'TYPED-02'},[second.employmentId],1],
  [{limit:1,offset:1},[second.employmentId],2],
  [{offset:10},[],2],
 ] as const){
  const filters={companyIds:[base.companyId],limit:25,offset:0,...extra};
  const actual=await readPersonnelOverview(ctx,filters,{}),exact=await readPersonnelOverview(ctx,filters,{},{compareExact:true});
  expect(normalize(actual)).toEqual(normalize(exact));
  expect(actual.employees.rows.map(row=>row.employmentId)).toEqual(expected);expect(actual.employees.total).toBe(total);
  expect(actual.headcount.total).toBe(2);expect(actual.employees.rows.every(row=>row.departmentId===base.deptA)).toBe(true);
 }
 const scope=sql`array[${base.companyId}::uuid]`,day=todayInKualaLumpur();
 const parity=await withTenant(ctx,tx=>tx.execute<{same:boolean}>(sql`
  select to_jsonb(t)=n.value as same from app.personnel_overview_filter_fields(${day}::date,${scope}) t
  join app.personnel_overview_narrow_rows(${day}::date,${scope}) n(value) on n.value->>'employmentId'=t."employmentId"::text
 `));
 expect(parity).toHaveLength(2);expect(parity.every(row=>row.same)).toBe(true);
 expect(await withTenant(ctx,tx=>tx.execute(sql`select * from app.personnel_overview_filter_fields(${day}::date,array[${foreign.companyId}::uuid])`))).toHaveLength(0);
 const corrected=await seedPersonnelCorrectionFixture();
 for(const at of [corrected.hiredOn,day]){
  const companies=sql`array[${sql.join(corrected.companies.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
  const [row]=await withTenant(corrected.ctx,tx=>tx.execute<{same:boolean}>(sql`
   select to_jsonb(t)=n.value as same from app.personnel_overview_filter_fields(${at}::date,${companies}) t
   join app.personnel_overview_narrow_rows(${at}::date,${companies}) n(value) on n.value->>'employmentId'=t."employmentId"::text
   where t."employmentId"=${corrected.employmentId}::uuid
  `));expect(row.same).toBe(true);
 }
});

it('installs on a populated predecessor without changing source facts, full DTOs or privileges',async()=>{
 const base=await seedBase(),ctx=adminCtx(base);
 await hireEmployee(ctx,{person:{fullName:'Fictional retained upgrade employee'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const scope=sql`array[${base.companyId}::uuid]`,day=todayInKualaLumpur();
 const before=await withTenant(ctx,tx=>tx.execute(sql`select value from app.personnel_filter_rows(${day}::date,${scope}) r(value) order by value->>'employmentId'`));
 await owner.client.begin(async tx=>{await tx.unsafe('drop function '+typed);await tx.unsafe(migration);});
 const after=await withTenant(ctx,tx=>tx.execute(sql`select value from app.personnel_filter_rows(${day}::date,${scope}) r(value) order by value->>'employmentId'`));
 expect(after).toHaveLength(1);expect(Array.from(after)).toEqual(Array.from(before));
 const [attributes]=await owner.db.execute(sql`select p.prosecdef,p.provolatile,p.proconfig,
  p.proowner=(select proowner from pg_proc where oid='app.personnel_filter_rows(date,uuid[])'::regprocedure) as same_owner,
  has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,
  exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
  from pg_proc p where p.oid=${typed}::regprocedure`);
 expect(attributes).toMatchObject({prosecdef:true,provolatile:'s',proconfig:['search_path=pg_catalog, public, app'],same_owner:true,app_execute:true,public_execute:false});
 expect((await readPersonnelOverview(ctx,{companyIds:[base.companyId],limit:25,offset:0},{})).employees.rows).toHaveLength(1);
});

it.each([
 'alter table public.assignment rename constraint assignment_no_overlap to unreviewed_assignment',
 'alter function app.personnel_overview_narrow_rows(date,uuid[]) volatile',
 'alter function app.personnel_overview_narrow_rows(date,uuid[]) security invoker',
 'alter function app.personnel_overview_narrow_rows(date,uuid[]) set search_path=public',
 'grant execute on function app.personnel_overview_narrow_rows(date,uuid[]) to public',
])('refuses unreviewed predecessor drift and rolls back (%s)',async drift=>{
 await expect(owner.client.begin(async tx=>{
  await tx.unsafe('drop function '+typed);await tx.unsafe(drift);await tx.unsafe(migration);
 })).rejects.toMatchObject({code:'55000'});
 const [retained]=await owner.client`select to_regprocedure(${typed}) is not null as present`;
 expect(retained.present).toBe(true);
});
