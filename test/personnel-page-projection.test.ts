/** Native Personnel page contract: same authorized rows/facets, one projection evaluation. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {withTenant} from '../db/client';
import {countEmployeesByStatus,listEmployeesPage,personnelListPage,type EmployeeListFilters} from '../core/read';
import {headcountFilters,parsePersonnelListQuery,type PersonnelSearchParams} from '../app/admin/personnel/list-query';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('retains native scope, exact rows/order, pager and status facets while evaluating the Workforce projection once',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 async function population(base:Base,size:number,prefix:string){
  const people=Array.from({length:size},(_,i)=>({id:randomUUID(),tenantId:base.tenantId,fullName:'Fictional Personnel '+prefix+String(i).padStart(6,'0'),primaryEmail:prefix+i+'@example.invalid'}));
  const employments=people.map((p,i)=>({id:randomUUID(),tenantId:base.tenantId,personId:p.id,companyId:base.companyId,employeeCode:prefix+String(i).padStart(6,'0'),hiredOn:'2020-01-01',terminatedOn:i%5===0?'2024-01-01':null}));
  for(let offset=0;offset<size;offset+=256){
   await owner.db.insert(s.person).values(people.slice(offset,offset+256));
   await owner.db.insert(s.employment).values(employments.slice(offset,offset+256));
   await owner.db.insert(s.assignment).values(employments.slice(offset,offset+256).map((e,i)=>({tenantId:base.tenantId,employmentId:e.id,companyId:base.companyId,departmentId:i%2===0?base.deptA:base.deptB,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
  }
  return employments;
 }
 const employees=await population(b,512,'MAIN'),other=await population(foreign,7,'FOREIGN'),ctx=adminCtx(b);
 expect((await withTenant(ctx,tx=>tx.execute(sql`select current_user as role`)))[0].role).toBe('ai_hr_app');
 const profile=process.env.AIHR_CI_PG_STATEMENTS==='1';
 if(profile)await owner.client.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
 // This distinctive join belongs to the native projection body, not its calling statement.
 const projectionCalls=async()=>Number((await owner.client`select coalesce(sum(calls),0)::int as calls from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database()) and position('JOIN permitted allowed ON allowed.id=e.company_id' in query)>0 and position('jsonb_build_object(' in query)>0`)[0].calls);
 const inputs=(sp:PersonnelSearchParams)=>{
  const query=parsePersonnelListQuery(sp);
  return {page:{companyIds:[b.companyId],...query.filters,limit:25,offset:0},facets:{companyIds:[b.companyId],...headcountFilters(query)}};
 };
 const all=inputs({}),[listing,headcount]=await Promise.all([listEmployeesPage(ctx,all.page,'workforce'),countEmployeesByStatus(ctx,all.facets,'workforce')]);
 const before=profile?await projectionCalls():null,start=performance.now();
 const current=await personnelListPage(ctx,all.page,all.facets);
 const elapsedMs=performance.now()-start,after=profile?await projectionCalls():null;
 expect(current).toEqual({...listing,headcount});
 expect(current.total).toBe(employees.length);expect(current.headcount.total).toBe(employees.length);
 expect(current.rows.map(e=>e.employmentId)).toEqual(employees.slice(0,25).map(e=>e.id));
 expect(current.rows.some(e=>other.some(o=>o.id===e.employmentId))).toBe(false);
 for(const sp of [{bucket:'active'},{bucket:'resigned'},{q:'MAIN000010'},{dept:b.deptB},{company:foreign.companyId}] satisfies PersonnelSearchParams[]){
  const p=inputs(sp),[page,facets]=await Promise.all([listEmployeesPage(ctx,p.page,'workforce'),countEmployeesByStatus(ctx,p.facets,'workforce')]);
  expect(await personnelListPage(ctx,p.page,p.facets)).toEqual({...page,headcount:facets});
 }
 const empty=await personnelListPage(ctx,{...all.page,companyIds:[]},{...all.facets,companyIds:[]});
 expect(empty).toEqual({rows:[],total:0,headcount:{total:0,byStatus:{}}});
 const foreignOnly=await personnelListPage(ctx,{...all.page,companyIds:[foreign.companyId]},{...all.facets,companyIds:[foreign.companyId]});
 expect(foreignOnly).toEqual(empty);
 // Combined counting must retain independently filtered page/facet populations, including
 // zero page rows with nonzero facets and the inverse. Separate legacy readers are the oracle.
 const independentFilters:{page:EmployeeListFilters;facets:EmployeeListFilters;limit?:number;offset?:number}[]=[
  {page:{q:'NO_MATCH'},facets:{}},
  {page:{},facets:{q:'NO_MATCH'}},
  {page:{departmentIds:[b.deptA]},facets:{departmentIds:[b.deptB]}},
  {page:{companyIds:[]},facets:{}},
  {page:{},facets:{companyIds:[]}},
  {page:{employmentStatuses:['resigned']},facets:{employmentStatuses:['active']}},
  {page:{q:'MAIN000010'},facets:{q:'MAIN000010'},limit:0},
  {page:{},facets:{},offset:employees.length+10},
 ];
 for(const input of independentFilters){
  const page={...all.page,...input.page,limit:input.limit??25,offset:input.offset??0},facets={...all.facets,...input.facets};
  const [legacyPage,legacyFacets]=await Promise.all([listEmployeesPage(ctx,page,'workforce'),countEmployeesByStatus(ctx,facets,'workforce')]);
  expect(await personnelListPage(ctx,page,facets)).toEqual({...legacyPage,headcount:legacyFacets});
 }
 const pairedTimings: {round:number;order:string;legacyMs:number;composedMs:number}[]=[];
 for(let round=0;round<4;round++){
  let legacyMs=0,composedMs=0;
  const legacy=async()=>{
   const start=performance.now();const [rows,counts]=await Promise.all([listEmployeesPage(ctx,all.page,'workforce'),countEmployeesByStatus(ctx,all.facets,'workforce')]);
   legacyMs=performance.now()-start;expect({...rows,headcount:counts}).toEqual({...listing,headcount});
  };
  const composed=async()=>{
   const start=performance.now();const result=await personnelListPage(ctx,all.page,all.facets);
   composedMs=performance.now()-start;expect(result).toEqual({...listing,headcount});
  };
  if(round%2===0){await legacy();await composed();}else{await composed();await legacy();}
  pairedTimings.push({round,order:round%2===0?'legacy-composed':'composed-legacy',legacyMs,composedMs});
 }
 const report={pairedTimings,kind:'NATIVE_PERSONNEL_PROJECTION_COUNT_NOT_SYSTEM_CAPACITY',fictionalEmployments:519,visibleEmployments:512,pageRows:25,elapsedMs,projectionCalls:before===null||after===null?null:after-before,expectedProjectionCalls:1,exactRowsOrderPagerAndFacets:true,emptyAndForeignScopeRefused:true,limitations:'Fictional retained-volume fixture, not native hiring throughput or millions of Personnel records. Installed bounded Workforce projections; policies and table/column grants unchanged.'};
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/personnel-page-projection.json',JSON.stringify(report));
 if(profile){expect(before).toBeGreaterThanOrEqual(3);expect(after!-before!).toBe(1);}
},240000);
