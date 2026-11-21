/**
 * eaa7697c — the Personnel listing's visible "Search employee ID or name…" box, against the real private
 * search owner and native list reads. Fictional fixtures only.
 *
 * The box posts the listing's one private term, so these cases exercise createPersonnelPrivateSearch
 * with the shared employee-search rule (case, spaces and dashes in an Employee ID do not matter), its
 * intersection with Department and column criteria, and the existing actor/scope/identity fences.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {countEmployeesByStatus,listEmployeesPage} from '../core/read';
import {createPersonnelPrivateSearch,personnelPrivateSearchAvailable} from '../core/personnel-private-search';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});

type Fixture={key:string;name:string;code:string;dept:'A'|'B'};
const FIXTURES:Fixture[]=[
 {key:'john',name:'Fictional John Tan',code:'EMP-0007',dept:'A'},
 {key:'johnny',name:'Fictional Johnny Lim',code:'EMP-0031',dept:'B'},
 {key:'aiman',name:'Fictional Aiman Rahman',code:'EMP-0008',dept:'A'},
 {key:'mary',name:'Fictional Mary Johnson',code:'XYZ-0001',dept:'A'},
];
async function seed(){
 const ids:Record<string,{employmentId:string;personId:string}>={};
 for(const f of FIXTURES)ids[f.key]=await hireEmployee(ctx,{person:{fullName:f.name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:f.dept==='A'?b.deptA:b.deptB,employmentType:'full_time',hiredOn:'2024-01-01',employeeCode:f.code});
 return ids;
}
const search=(text:string,columnFilters:Parameters<typeof createPersonnelPrivateSearch>[1]['columnFilters']=[])=>createPersonnelPrivateSearch(ctx,{text,companyIds:[b.companyId],columnFilters,replaceCriteria:true});
const listed=async(privateSearch:string,extra:Partial<Parameters<typeof listEmployeesPage>[1]>={})=>(await listEmployeesPage(ctx,{companyIds:[b.companyId],privateSearch,limit:100,offset:0,...extra},'workforce')).rows.map(row=>row.employmentId).sort();
const idsOf=(ids:Record<string,{employmentId:string}>,keys:string[])=>keys.map(key=>ids[key].employmentId).sort();

it('finds an Employee ID ignoring case, spaces and dashes, and partial IDs and names, on the list and the counts',async()=>{
 const ids=await seed();
 for(const text of ['emp0008','EMP0008','emp-0008','EMP-0008',' emp 0008 ','0008']){
  const token=await search(text);
  expect(await listed(token),text).toEqual(idsOf(ids,['aiman']));
  expect((await countEmployeesByStatus(ctx,{companyIds:[b.companyId],privateSearch:token},'workforce')).total,text).toBe(1);
 }
 // Partial Employee ID: every EMP code, not the XYZ one.
 expect(await listed(await search('EMP'))).toEqual(idsOf(ids,['john','johnny','aiman']));
 expect(await listed(await search('emp00'))).toEqual(idsOf(ids,['john','johnny','aiman']));
 // Partial name, any case.
 expect(await listed(await search('john'))).toEqual(idsOf(ids,['john','johnny','mary']));
 expect(await listed(await search('JOHN'))).toEqual(idsOf(ids,['john','johnny','mary']));
 expect(await listed(await search('nobody-fictional'))).toEqual([]);
});

it('combines the search word with Department and a column filter, returning only the intersection',async()=>{
 const ids=await seed();
 // Independently computed expectation: name contains "john", Department A, Emp ID contains "EMP".
 const expected=FIXTURES.filter(f=>f.name.toLowerCase().includes('john')&&f.dept==='A'&&f.code.includes('EMP')).map(f=>f.key);
 expect(expected).toEqual(['john']);
 const token=await search('john',[{field:'code',operator:'contains',value:'EMP'}]);
 expect(await listed(token,{departmentId:b.deptA})).toEqual(idsOf(ids,expected));
 expect((await countEmployeesByStatus(ctx,{companyIds:[b.companyId],departmentId:b.deptA,privateSearch:token},'workforce')).total).toBe(expected.length);
 // Without the Department the column filter still narrows: Mary's XYZ code is excluded.
 expect(await listed(token)).toEqual(idsOf(ids,['john','johnny']));
});

it('clearing the word keeps the remaining column filter; nothing left means no token at all',async()=>{
 const ids=await seed();
 const token=await search('',[{field:'code',operator:'contains',value:'EMP'}]);
 expect(await listed(token)).toEqual(idsOf(ids,['john','johnny','aiman']));
 await expect(search('')).rejects.toThrow(/unavailable/);
});

it('a token from another actor or for another scope stays unusable',async()=>{
 const ids=await seed();const token=await search('emp0008');expect(await listed(token)).toEqual(idsOf(ids,['aiman']));
 const other={...ctx,userId:await createAppUser(b.tenantId,null,'hr_admin')};
 expect((await listEmployeesPage(other,{companyIds:[b.companyId],privateSearch:token,limit:100,offset:0},'workforce')).total).toBe(0);
 const [extra]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional other scope'}).returning();
 expect(await personnelPrivateSearchAvailable(ctx,token,[b.companyId,extra.id])).toBe(false);
 expect((await listEmployeesPage(ctx,{companyIds:[b.companyId,extra.id],privateSearch:token,limit:100,offset:0},'workforce')).total).toBe(0);
});

it('an identity-only match is refused without the identity permission, and the ID rule does not widen it',async()=>{
 const ids=await seed();
 await owner.db.insert(s.employeeStatutoryMy).values({tenantId:b.tenantId,personId:ids.mary.personId,icNumber:'900101-01-4321'}).onConflictDoUpdate({target:s.employeeStatutoryMy.personId,set:{icNumber:'900101-01-4321'}});
 expect(await listed(await search('900101-01-4321'))).toEqual(idsOf(ids,['mary']));
 await owner.db.insert(s.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,role:'hr_admin',permissionKey:'report.read.identity',allowed:false});
 expect(await listed(await search('900101-01-4321'))).toEqual([]);
 expect(await listed(await search('900101014321'))).toEqual([]);
 // Public matching still works for the same reader.
 expect(await listed(await search('xyz0001'))).toEqual(idsOf(ids,['mary']));
});
