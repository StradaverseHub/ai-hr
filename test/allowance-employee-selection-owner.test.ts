import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {allowanceEmployeePage,allowanceEmployeeValues} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import * as schema from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
async function hire(name:string,companyId=base.companyId,departmentId=base.deptA) {
 return hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@example.invalid`},companyId,departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
}
const search=(page=1,included:string[]=[],side:'available'|'included'='available')=>({companyId:base.companyId,page,included,side,query:''});
describe('allowance metadata remains bounded and scoped in the actual owner',()=>{
 it('keeps the true catalogue count after the final page moves to Included and searches named Employee IDs',async()=>{
  const employees=[];
  for(let i=1;i<=30;i++)employees.push(await hire(`Fictional allowance employee ${String(i).padStart(3,'0')}`));
  const first=await allowanceEmployeePage(adminCtx(base),search(1)),second=await allowanceEmployeePage(adminCtx(base),search(2));
  expect(first.rows).toHaveLength(25);expect(first.total).toBe(30);expect(second.rows).toHaveLength(5);expect(second.total).toBe(30);
  expect(first.rows[0]).toMatchObject({name:'Fictional allowance employee 001',department:'Finance'});
  const moved=second.rows.map(row=>row.id),empty=await allowanceEmployeePage(adminCtx(base),search(2,moved));
  expect(empty.rows).toEqual([]);expect(empty.total).toBe(25);
  const included=await allowanceEmployeePage(adminCtx(base),search(1,moved,'included'));expect(included.total).toBe(5);expect(included.unavailable).toEqual([]);
  const code=first.rows[0].code;expect(code).toBeTruthy();
  const exact=await allowanceEmployeePage(adminCtx(base),{...search(),query:code!});
  expect(exact.rows.map(row=>row.id)).toContain(first.rows[0].id);
  for(const row of first.rows)expect(Object.keys(row).sort()).toEqual(['businessUnit','code','department','id','name','total']);
 },120_000);
 it('returns unavailable IDs without foreign identities and refuses non-admin or forged privilege claims',async()=>{
  const own=await hire('Fictional allowed worker'),[foreignCompany]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional foreign allowance company'}).returning();
  const [foreignDepartment]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:foreignCompany.id,name:'Fictional foreign department'}).returning();
  const foreign=await hire('Private foreign employee',foreignCompany.id,foreignDepartment.id),unknown=randomUUID();
  const scoped={...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:base.companyId}]};
  const result=await allowanceEmployeePage(scoped,search(1,[own.employmentId,foreign.employmentId,unknown],'included'));
  expect(result.rows.map(row=>row.id)).toEqual([own.employmentId]);expect(result.unavailable).toEqual([foreign.employmentId,unknown]);expect(JSON.stringify(result)).not.toContain('Private foreign employee');
  await expect(allowanceEmployeePage(scoped,{...search(),companyId:foreignCompany.id})).rejects.toThrow();
  const userId=await createAppUser(base.tenantId,own.personId,'employee'),employee:SessionContext={...adminCtx(base),userId,personId:own.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}]};
  await expect(allowanceEmployeePage(employee,search())).rejects.toThrow();
  await expect(allowanceEmployeePage({...employee,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},search())).rejects.toThrow();
 });
 it('pages a catalogue over one thousand choices and resolves selected values beyond the first page without leaking foreign labels',async()=>{
  const rows=await owner.db.insert(schema.department).values(Array.from({length:1003},(_,i)=>({tenantId:base.tenantId,companyId:base.companyId,name:`Fictional catalogue department ${String(i).padStart(4,'0')}`}))).returning();
  const [foreignCompany]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional other catalogue company'}).returning();
  const [foreign]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:foreignCompany.id,name:'Private foreign catalogue label'}).returning();
  const scoped={...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:base.companyId}]};
  const first=await allowanceEmployeeValues(scoped,{companyId:base.companyId,field:'departmentId',query:'Fictional catalogue',page:1});
  expect(first.rows).toHaveLength(25);expect(first.hasMore).toBe(true);
  const target=rows.find(row=>row.name==='Fictional catalogue department 1002')!;
  expect(first.rows.map(row=>row.id)).not.toContain(target.id);
  const selected=await allowanceEmployeeValues(scoped,{companyId:base.companyId,field:'departmentId',query:'',page:1,selected:[target.id,foreign.id]});
  expect(selected.rows).toEqual([{id:target.id,label:target.name}]);expect(selected.hasMore).toBe(false);
  expect(JSON.stringify(selected)).not.toContain('Private foreign catalogue label');
 });
});
