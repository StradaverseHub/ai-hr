/** Actual app-role nationality aggregation, against the frozen pre-change query
 * and independent fictional facts. Equal-count bucket order was unspecified. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {assignment,company,department,employeeStatutoryMy,employment,person,reportingLine,roleAssignment} from '../db/schema';
import {analyticsDashboard,demographicsByNationality,UNKNOWN_BUCKET,type AnalyticsFilters,type DimensionCount} from '../core/analytics';
import {hireEmployee,setEmploymentInfo,setReportingLine,terminateEmployment} from '../core/org';
import {parsePageQuery} from '../lib/pagination';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {observeNativeRead} from './helpers/native-read-observer';
import {legacyDemographicsByNationality} from './performance/analytics-nationality-legacy-oracle';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const asOf='2026-06-30';
type Options={asOf:string;filters?:AnalyticsFilters};
const buckets=(rows:DimensionCount[])=>[...rows].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
function expectBuckets(actual:DimensionCount[]|null,expected:DimensionCount[]){
 expect(actual).not.toBeNull();expect(buckets(actual!)).toEqual(buckets(expected));
 expect(actual!.every((row,index)=>index===0||actual![index-1].count>=row.count)).toBe(true);
}
async function observed<T>(read:()=>Promise<T>){
 const probe=observeNativeRead();
 try{return {result:await read(),queries:probe.queries,properties:probe.properties,state:probe.state};}
 finally{probe.restore();}
}
async function parity(ctx:SessionContext,scope:string[]|undefined,opts:Options,expected:DimensionCount[]){
 const legacy=await observed(()=>legacyDemographicsByNationality(ctx,scope,opts));
 const current=await observed(()=>demographicsByNationality(ctx,scope,opts));
 expectBuckets(legacy.result,expected);expectBuckets(current.result,expected);
 expect(buckets(current.result!)).toEqual(buckets(legacy.result!));
 expect(legacy.queries).toHaveLength(1);expect(current.queries).toHaveLength(1);
 const oldQuery=legacy.queries[0],query=current.queries[0];
 expect(oldQuery.sql).toMatch(/^select distinct /);expect(query.sql).toContain('count(distinct "person"."id")');
 expect(query.sql).toMatch(/group by "employee_statutory_my"\."epf_citizenship"$/);
 // Exact original joins, WHERE and parameter ordering survive the projection change.
 const from=' from "employment"';
 expect(query.sql.slice(query.sql.indexOf(from)).replace(/ group by "employee_statutory_my"\."epf_citizenship"$/,'')).toBe(oldQuery.sql.slice(oldQuery.sql.indexOf(from)));
 expect(query.params).toEqual(oldQuery.params);
 expect(query.rows).toBe(expected.length);expect(query.rows).toBeLessThanOrEqual(4);
 expect(current.properties).toHaveLength(1);expect(current.properties[0].role).toBe('ai_hr_app');
 expect(current.state).toEqual({active:0,maxActive:1});
 return {legacy,current};
}
async function hire(b:Base,name:string,opts:{departmentId?:string;companyId?:string;hiredOn?:string}={}){
 return hireEmployee(adminCtx(b),{person:{fullName:'Fictional nationality '+name,primaryEmail:randomUUID()+'@example.invalid'},
  companyId:opts.companyId??b.companyId,departmentId:opts.departmentId??b.deptA,employmentType:'full_time',hiredOn:opts.hiredOn??'2020-01-01'});
}
async function statutory(b:Base,personId:string,citizenship:'citizen'|'pr'|'non_citizen',index:number){
 await owner.db.insert(employeeStatutoryMy).values({tenantId:b.tenantId,personId,epfCitizenship:citizenship,icNumber:'90010101'+String(index).padStart(4,'0')});
}

it('aggregates one native query to four exact buckets while concurrent employments count one person and missing statutory stays Unknown',async()=>{
 const b=await seedBase(),ctx=adminCtx(b);
 const multi=await hire(b,'Multi'),citizen=await hire(b,'Citizen'),citizenTwo=await hire(b,'Citizen Two'),foreignCitizen=await hire(b,'Noncitizen');
 await hire(b,'Missing Statutory');
 await hireEmployee(ctx,{person:{id:multi.personId},companyId:b.companyId,departmentId:b.deptB,employmentType:'part_time',hiredOn:'2026-03-01'});
 await statutory(b,multi.personId,'pr',1);await statutory(b,citizen.personId,'citizen',2);
 await statutory(b,citizenTwo.personId,'citizen',3);await statutory(b,foreignCitizen.personId,'non_citizen',4);
 const result=await parity(ctx,[b.companyId],{asOf},[{name:'citizen',count:2},{name:'pr',count:1},{name:'non_citizen',count:1},{name:UNKNOWN_BUCKET,count:1}]);
 expect(result.legacy.queries[0].rows).toBe(5);expect(result.current.queries[0].rows).toBe(4);
 expect(result.current.result!.reduce((sum,row)=>sum+row.count,0)).toBe(5);
});

it('retains native tenant/company RLS and exact company intersections under a real company-scoped administrator',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),own=await hire(b,'Own');await statutory(b,own.personId,'citizen',1);
 const [other]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional nationality other company'}).returning({id:company.id});
 const [otherDepartment]=await owner.db.insert(department).values({tenantId:b.tenantId,companyId:other.id,name:'Other'}).returning({id:department.id});
 const otherEmployee=await hire(b,'Other',{companyId:other.id,departmentId:otherDepartment.id});await statutory(b,otherEmployee.personId,'pr',2);
 const foreign=await seedBase(),outside=await hire(foreign,'Outside');await statutory(foreign,outside.personId,'non_citizen',3);
 const userId=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,userId));
 const scoped:SessionContext={tenantId:b.tenantId,userId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
 await parity(scoped,[],{asOf},[{name:'citizen',count:1}]);
 await parity(scoped,[other.id],{asOf},[]);await parity(ctx,[foreign.companyId],{asOf},[]);
 await parity(ctx,undefined,{asOf,filters:{companyId:other.id}},[{name:'pr',count:1}]);
 await parity(ctx,[b.companyId],{asOf,filters:{companyId:other.id}},[]);
});

it('keeps exact as-of/lifecycle, current-assignment, person and free-text filter composition',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),ann=await hire(b,'Ann'),bob=await hire(b,'Bob',{departmentId:b.deptB}),dan=await hire(b,'Dan');
 await hire(b,'Future',{hiredOn:'2026-07-01'});
 await statutory(b,ann.personId,'citizen',1);await statutory(b,bob.personId,'pr',2);await statutory(b,dan.personId,'non_citizen',3);
 await owner.db.update(person).set({gender:'female'}).where(eq(person.id,ann.personId));
 await owner.db.update(employment).set({workState:'Selangor'}).where(eq(employment.id,ann.employmentId));
 await owner.db.update(assignment).set({costCenterId:b.costCenterId}).where(eq(assignment.employmentId,ann.employmentId));
 await setEmploymentInfo(ctx,{employmentId:dan.employmentId,confirmationDate:'2026-12-01'});
 await parity(ctx,[b.companyId],{asOf:'2026-05-31',filters:{departmentId:b.deptB}},[{name:'pr',count:1}]);
 await terminateEmployment(ctx,{employmentId:bob.employmentId,terminationDate:'2026-06-01',terminationType:'voluntary'});
 expect(await owner.db.select({departmentId:assignment.departmentId,validTo:assignment.validTo,supersededAt:assignment.supersededAt})
  .from(assignment).where(eq(assignment.employmentId,bob.employmentId))).toEqual([{departmentId:b.deptB,validTo:'2026-06-01',supersededAt:null}]);
 const citizen=[{name:'citizen',count:1}],noncitizen=[{name:'non_citizen',count:1}];
 await parity(ctx,[b.companyId],{asOf},[...citizen,...noncitizen]);
 await parity(ctx,[b.companyId],{asOf:'2019-12-31'},[]);
 await parity(ctx,[b.companyId],{asOf,filters:{lifecycleStatus:'terminated'}},[{name:'pr',count:1}]);
 await parity(ctx,[b.companyId],{asOf:'2026-05-31',filters:{departmentId:b.deptB}},[]);
 await parity(ctx,[b.companyId],{asOf,filters:{departmentId:b.deptB}},[]);
 await parity(ctx,[b.companyId],{asOf,filters:{gender:'female',workState:'Selangor',q:'Ann'}},citizen);
 await parity(ctx,[b.companyId],{asOf,filters:{gender:'female',q:'Dan'}},[]);
 await parity(ctx,[b.companyId],{asOf,filters:{costCenterId:b.costCenterId}},citizen);
 await parity(ctx,[b.companyId],{asOf,filters:{costCenterId:b.costCenterId,q:'Dan'}},[]);
 await parity(ctx,[b.companyId],{asOf,filters:{assignmentStatus:'probation'}},noncitizen);
 await parity(ctx,[b.companyId],{asOf,filters:{q:'%'}},[...citizen,...noncitizen]);
});

it('retains the open nonsuperseded direct-manager filter without counting a concurrent subordinate twice',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),manager=await hire(b,'Manager'),subordinate=await hire(b,'Subordinate');
 await statutory(b,subordinate.personId,'pr',1);
 await hireEmployee(ctx,{person:{id:subordinate.personId},companyId:b.companyId,departmentId:b.deptB,employmentType:'part_time',hiredOn:'2026-01-01'});
 await setReportingLine(ctx,{subordinateEmploymentId:subordinate.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 await parity(ctx,[b.companyId],{asOf,filters:{managerEmploymentId:manager.employmentId}},[{name:'pr',count:1}]);
 await owner.db.update(reportingLine).set({supersededAt:new Date()}).where(eq(reportingLine.managerEmploymentId,manager.employmentId));
 await parity(ctx,[b.companyId],{asOf,filters:{managerEmploymentId:manager.employmentId}},[]);
});

it('omits nationality before any query for a real manager and retains fresh dashboard principal refusal after admin revocation',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),employee=await hire(b,'Manager');
 const userId=await createAppUser(b.tenantId,employee.personId,'manager');
 const manager:SessionContext={tenantId:b.tenantId,userId,personId:employee.personId,roles:['manager']};
 for(const read of [legacyDemographicsByNationality,demographicsByNationality]){
  const result=await observed(()=>read(manager,[b.companyId],{asOf}));
  expect(result.result).toBeNull();expect(result.queries).toEqual([]);expect(result.properties).toEqual([]);
 }
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,b.adminUserId));
 const probe=observeNativeRead(),page=parsePageQuery();
 try{
  await expect(analyticsDashboard(ctx,[b.companyId],{from:'2026-01-01',to:asOf,year:2026,filters:{},pages:{hires:page,terms:page,changeJobs:page,carryForward:page}})).rejects.toThrow('calling authority');
  expect(probe.queries.some(row=>row.sql.includes('"epf_citizenship"'))).toBe(false);
  expect(probe.state.active).toBe(0);
 }finally{probe.restore();}
});
