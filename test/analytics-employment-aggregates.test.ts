/** Native parity against the frozen original five reads and independent
 * fictional facts. The dashboard is the only consumer adopting these aggregates. */
import {randomUUID} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {assignment,company,department,employment,person,roleAssignment} from '../db/schema';
import {analyticsDashboard,type AnalyticsFilters,type TurnoverResult,type MovementRow} from '../core/analytics';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {hireEmployee,setEmploymentInfo,setReportingLine,terminateEmployment,transferEmployee} from '../core/org';
import {parsePageQuery} from '../lib/pagination';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {originalEmploymentAggregatesTx} from './helpers/analytics-employment-aggregates-original';
import {observeNativeRead,type NativeReadQuery} from './helpers/native-read-observer';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
type Input={from:string;to:string;filters?:AnalyticsFilters};
const period={from:'2026-01-01',to:'2026-02-01'};
const oldMovement=(query:NativeReadQuery)=>query.sql.includes('to_char("employment"."hired_on"')||query.sql.includes('to_char("employment"."terminated_on"');
const oldTurnover=(query:NativeReadQuery)=>/^select count\(\*\) from "employment" where /.test(query.sql);
const candidateAggregate=(query:NativeReadQuery)=>query.sql.includes('analytics_turnover_leavers')||query.sql.includes('analytics_movement_event');
function dashboard(ctx:SessionContext,scope:string[]|undefined,p:Input){
 const page=parsePageQuery();return analyticsDashboard(ctx,scope,{...p,year:2026,filters:p.filters??{},pages:{hires:page,terms:page,changeJobs:page,carryForward:page}});
}
async function original(ctx:SessionContext,scope:string[]|undefined,p:Input){
 return database.withTenant(ctx,async tx=>{await assertAiPresentationPrincipalTx(tx,ctx);return originalEmploymentAggregatesTx(tx,scope,p);},{readOnlySnapshot:true});
}
async function observed<T>(read:()=>Promise<T>){
 const probe=observeNativeRead();try{return {value:await read(),queries:probe.queries,properties:probe.properties,state:probe.state};}finally{probe.restore();}
}
async function parity(ctx:SessionContext,scope:string[]|undefined,p:Input,expected?:{turnover:TurnoverResult;movement:MovementRow[]}){
 const old=await observed(()=>original(ctx,scope,p)),current=await observed(()=>dashboard(ctx,scope,p));
 const actual={turnover:current.value.turnover,movement:current.value.movement};expect(actual).toEqual(old.value);if(expected)expect(actual).toEqual(expected);
 expect(old.queries.filter(q=>oldTurnover(q)||oldMovement(q))).toHaveLength(5);
 expect(current.queries.filter(candidateAggregate)).toHaveLength(p.filters?.assignmentStatus?1:2);
 const movement=current.queries.filter(oldMovement);
 expect(movement).toEqual(p.filters?.assignmentStatus?old.queries.filter(oldMovement):[]);
 for(const result of [old,current]){
  expect(result.properties).toHaveLength(1);expect(result.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});
  expect(result.state).toEqual({active:0,maxActive:1});
 }
 return {old,current,actual};
}
async function fixture(){
 const b=await seedBase(),ctx=adminCtx(b);
 const hire=(name:string,hiredOn:string,departmentId=b.deptA)=>hireEmployee(ctx,{person:{fullName:'Fictional aggregate '+name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId,employmentType:'full_time',hiredOn});
 const ann=await hire('Ann','2026-01-01'),bob=await hire('Bob','2026-01-31',b.deptB),cara=await hire('Cara','2026-02-01'),drew=await hire('Drew','2026-03-01',b.deptB);
 await terminateEmployment(ctx,{employmentId:bob.employmentId,terminationDate:'2026-02-01',terminationType:'voluntary'});
 return {b,ctx,hire,ann,bob,cara,drew};
}
const expected={turnover:{leavers:1,headcountStart:1,headcountEnd:2,avgHeadcount:1.5,turnoverPct:66.7},movement:[
 {month:'2026-01',hires:2,leavers:0,netChange:2},{month:'2026-02',hires:1,leavers:1,netChange:0},
]};

it('preserves inclusive event dates, strict active termination, exact rounding, reversed windows and empty populations',async()=>{
 const f=await fixture();await parity(f.ctx,[f.b.companyId],period,expected);
 await parity(f.ctx,[f.b.companyId],{from:'2026-02-02',to:'2026-01-31'},{turnover:{leavers:0,headcountStart:2,headcountEnd:2,avgHeadcount:2,turnoverPct:0},movement:[]});
 await parity(f.ctx,[randomUUID()],period,{turnover:{leavers:0,headcountStart:0,headcountEnd:0,avgHeadcount:0,turnoverPct:0},movement:[]});
 const sameDay=await f.hire('Same day','2026-01-15');await terminateEmployment(f.ctx,{employmentId:sameDay.employmentId,terminationDate:'2026-01-15',terminationType:'voluntary'});
 await parity(f.ctx,[f.b.companyId],{from:'2026-01-15',to:'2026-01-15'},{turnover:{leavers:1,headcountStart:1,headcountEnd:1,avgHeadcount:1,turnoverPct:100},movement:[{month:'2026-01',hires:1,leavers:1,netChange:0}]});
});

it('keeps company-only turnover distinct from every existing movement filter and its intentionally ignored filters',async()=>{
 const f=await fixture();await owner.db.update(person).set({gender:'female'}).where(eq(person.id,f.ann.personId));
 await owner.db.update(employment).set({workState:'Selangor'}).where(eq(employment.id,f.ann.employmentId));
 await owner.db.update(assignment).set({costCenterId:f.b.costCenterId}).where(and(eq(assignment.employmentId,f.ann.employmentId),isNull(assignment.validTo)));
 await setReportingLine(f.ctx,{subordinateEmploymentId:f.ann.employmentId,managerEmploymentId:f.drew.employmentId,lineType:'administrative',validFrom:'2026-03-01'});
 const filters:AnalyticsFilters={companyId:f.b.companyId,departmentId:f.b.deptA,costCenterId:f.b.costCenterId,gender:'female',workState:'Selangor',managerEmploymentId:f.drew.employmentId,q:'Ann',lifecycleStatus:'terminated',nationality:'non_citizen'};
 await parity(f.ctx,[f.b.companyId],{...period,filters},{turnover:expected.turnover,movement:[{month:'2026-01',hires:1,leavers:0,netChange:1}]});
 await parity(f.ctx,[f.b.companyId],{...period,filters:{...filters,q:'Cara'}},{turnover:expected.turnover,movement:[]});
 await parity(f.ctx,[f.b.companyId],{...period,filters:{companyId:randomUUID()}},{turnover:{leavers:0,headcountStart:0,headcountEnd:0,avgHeadcount:0,turnoverPct:0},movement:[]});
});

it('retains employment multiplicity, current assignment and left-joined no-assignment membership without counting history',async()=>{
 const f=await fixture();await hireEmployee(f.ctx,{person:{id:f.ann.personId},companyId:f.b.companyId,departmentId:f.b.deptA,employmentType:'part_time',hiredOn:'2026-01-10'});
 await transferEmployee(f.ctx,{employmentId:f.ann.employmentId,effectiveDate:'2026-01-15',departmentId:f.b.deptB});
 await owner.db.update(assignment).set({validTo:'2026-03-01'}).where(and(eq(assignment.employmentId,f.cara.employmentId),isNull(assignment.validTo)));
 await parity(f.ctx,[f.b.companyId],period,{turnover:{leavers:1,headcountStart:1,headcountEnd:3,avgHeadcount:2,turnoverPct:50},movement:[{month:'2026-01',hires:3,leavers:0,netChange:3},{month:'2026-02',hires:1,leavers:1,netChange:0}]});
 await parity(f.ctx,[f.b.companyId],{...period,filters:{departmentId:f.b.deptB}},{turnover:{leavers:1,headcountStart:1,headcountEnd:3,avgHeadcount:2,turnoverPct:50},movement:[{month:'2026-01',hires:1,leavers:0,netChange:1}]});
});

it('retains genuine scoped HR, manager, employee and foreign fences including original empty-array scope semantics',async()=>{
 const f=await fixture(),[other]=await owner.db.insert(company).values({tenantId:f.b.tenantId,legalName:'Fictional aggregate other company'}).returning({id:company.id});
 const [otherDept]=await owner.db.insert(department).values({tenantId:f.b.tenantId,companyId:other.id,name:'Fictional other department'}).returning({id:department.id});
 await hireEmployee(f.ctx,{person:{fullName:'Fictional aggregate other',primaryEmail:randomUUID()+'@example.invalid'},companyId:other.id,departmentId:otherDept.id,employmentType:'full_time',hiredOn:'2026-01-01'});
 const userId=await createAppUser(f.b.tenantId,null,'hr_admin');await owner.db.update(roleAssignment).set({companyId:f.b.companyId}).where(eq(roleAssignment.appUserId,userId));
 const scoped:SessionContext={tenantId:f.b.tenantId,userId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:f.b.companyId}]};
 await parity(scoped,[],period,expected);await parity(scoped,undefined,period,expected);
 await parity(scoped,[other.id],period,{turnover:{leavers:0,headcountStart:0,headcountEnd:0,avgHeadcount:0,turnoverPct:0},movement:[]});
 const foreign=await seedBase();await parity(f.ctx,[foreign.companyId],period,{turnover:{leavers:0,headcountStart:0,headcountEnd:0,avgHeadcount:0,turnoverPct:0},movement:[]});
 const employee:SessionContext={tenantId:f.b.tenantId,userId:await createAppUser(f.b.tenantId,f.ann.personId,'employee'),personId:f.ann.personId,roles:['employee']};
 const own=await parity(employee,[],period,{turnover:{leavers:0,headcountStart:1,headcountEnd:1,avgHeadcount:1,turnoverPct:0},movement:[{month:'2026-01',hires:1,leavers:0,netChange:1}]});expect(own.current.value.nationality).toBeNull();
 await setReportingLine(f.ctx,{subordinateEmploymentId:f.ann.employmentId,managerEmploymentId:f.drew.employmentId,lineType:'administrative',validFrom:'2026-03-01'});
 const manager:SessionContext={tenantId:f.b.tenantId,userId:await createAppUser(f.b.tenantId,f.drew.personId,'manager'),personId:f.drew.personId,roles:['manager']};
 const managed=await parity(manager,[],{...period,filters:{q:'Ann'}});expect(managed.actual.movement).toEqual([{month:'2026-01',hires:1,leavers:0,netChange:1}]);expect(managed.current.value.nationality).toBeNull();
});

it('delegates every truthy derived-status filter to the exact original two movement queries and clock owner',async()=>{
 const f=await fixture();await setEmploymentInfo(f.ctx,{employmentId:f.ann.employmentId,confirmationDate:'2099-01-01'});
 const probation=await parity(f.ctx,[f.b.companyId],{...period,filters:{assignmentStatus:'probation'}});
 expect(probation.actual.turnover).toEqual(expected.turnover);expect(probation.actual.movement).toEqual([{month:'2026-01',hires:1,leavers:0,netChange:1}]);
 const retired=await parity(f.ctx,[f.b.companyId],{...period,filters:{assignmentStatus:'on_leave'}});expect(retired.actual.movement).toEqual([]);
 await parity(f.ctx,[f.b.companyId],{...period,filters:{assignmentStatus:''}},expected);
});

it('keeps the admitted snapshot after a genuine committed transfer between the turnover and movement reads',async()=>{
 const f=await fixture(),p={...period,filters:{departmentId:f.b.deptA}},before=await original(f.ctx,[f.b.companyId],p);let changed=false;
 const probe=observeNativeRead({after:async query=>{if(!changed&&query.sql.includes('analytics_turnover_leavers')){
  changed=true;await transferEmployee(f.ctx,{employmentId:f.ann.employmentId,effectiveDate:'2026-01-15',departmentId:f.b.deptB});
 }}});
 try{const value=await dashboard(f.ctx,[f.b.companyId],p);expect({turnover:value.turnover,movement:value.movement}).toEqual(before);}finally{probe.restore();}
 expect(changed).toBe(true);const next=await dashboard(f.ctx,[f.b.companyId],p);
 expect(next.turnover).toEqual(before.turnover);expect(next.movement).toEqual([{month:'2026-02',hires:1,leavers:0,netChange:1}]);
});

it('refuses stale principals before aggregates, remains native read-only behind an Access writer and appends no read audit',async()=>{
 const f=await fixture(),actual=database.withTenant;
 for(const forged of [{...f.ctx,personId:randomUUID()},{...f.ctx,grants:[{role:'super_admin',companyId:null}]},{...f.ctx,statutoryOverride:'forged presentation'}]){
  const probe=observeNativeRead();try{await expect(dashboard(forged,[f.b.companyId],period)).rejects.toThrow('calling authority');expect(probe.queries.some(candidateAggregate)).toBe(false);}finally{probe.restore();}
 }
 const [before]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${f.b.tenantId}::uuid`;
 const limits=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);return read(tx);
 },options));
 try{await owner.client.begin(async writer=>{await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+f.b.tenantId},0))`;
  const value=await dashboard(f.ctx,[f.b.companyId],period);expect({turnover:value.turnover,movement:value.movement}).toEqual(expected);
 });}finally{limits.mockRestore();}
 const [after]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${f.b.tenantId}::uuid`;expect(after).toEqual(before);
 let readOnlyFailure:unknown;const denied=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(ctx,async tx=>{
  await tx.update(company).set({legalName:'Fictional forbidden read write'}).where(eq(company.id,f.b.companyId));return read(tx);
 },options));
 try{try{await dashboard(f.ctx,[f.b.companyId],period);}catch(error){readOnlyFailure=error;}}finally{denied.mockRestore();}
 const codes:string[]=[];for(let error=readOnlyFailure;error&&typeof error==='object';error=(error as {cause?:unknown}).cause)if('code'in error)codes.push(String(error.code));
 expect(codes).toContain('25006');
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.b.adminUserId));await expect(dashboard(f.ctx,[f.b.companyId],period)).rejects.toThrow('calling authority');
});
