import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as schema from '../db/schema';
import {
 analyticsDashboard,headcountSummary,newHiresPage,terminationsPage,turnoverRateFiltered,changeJobTransactionsPage,
 workforceDemographics,demographicsByNationality,leaveUtilisation,leaveBalancesSummary,sickLeaveTrend,movementByMonth,
 carryForwardReportPage,masterDataCount,type AnalyticsDashboardInput,
} from '../core/analytics';
import {hireEmployee,terminateEmployment,transferEmployee,setReportingLine} from '../core/org';
import {createEntitlementTemplate} from '../core/entitlement-template';
import {CARRY_FORFEIT_REASON_CAP} from '../core/leave';
import {parsePageQuery} from '../lib/pagination';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {observeNativeRead as observe,type NativeReadQuery as Query} from './helpers/native-read-observer';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const input=():AnalyticsDashboardInput=>({from:'2026-01-01',to:'2026-06-30',year:2026,filters:{},
 pages:{hires:parsePageQuery(),terms:parsePageQuery(),changeJobs:parsePageQuery(),carryForward:parsePageQuery()}});
/** The original page's thirteen public read owners, evaluated serially for a stable
 * native comparison. Source extraction separately pins every original report body. */
async function standaloneDashboard(ctx:SessionContext,scope:string[]|undefined,p:AnalyticsDashboardInput){
 const {from,to,year,filters,pages}=p,filter={departmentId:filters.departmentId,q:filters.q};
 const hc=await headcountSummary(ctx,scope,{asOf:to});
 const hires=await newHiresPage(ctx,scope,{from,to,filter,page:pages.hires});
 const terms=await terminationsPage(ctx,scope,{from,to,filter,page:pages.terms});
 const turnover=await turnoverRateFiltered(ctx,scope,{from,to,filters});
 const changeJobs=await changeJobTransactionsPage(ctx,scope,{from,to,filter,page:pages.changeJobs});
 const demographics=await workforceDemographics(ctx,scope,{asOf:to,filters});
 const nationality=await demographicsByNationality(ctx,scope,{asOf:to,filters});
 const leaveUtil=await leaveUtilisation(ctx,scope,filters);
 const leaveBalances=await leaveBalancesSummary(ctx,scope,filters);
 const sickTrend=await sickLeaveTrend(ctx,scope,{from,to,filters});
 const movement=await movementByMonth(ctx,scope,{from,to,filters});
 const carryForward=await carryForwardReportPage(ctx,scope,{year,filter,companyId:filters.companyId,page:pages.carryForward});
 const masterCount=await masterDataCount(ctx,scope,{filter});
 return {hc,hires,terms,turnover,changeJobs,demographics,nationality,leaveUtil,leaveBalances,sickTrend,movement,carryForward,masterCount};
}
async function fixture(){
 const b=await seedBase(),ctx=adminCtx(b),employees=[];
 for(const [name,hiredOn] of [['Ann','2020-01-01'],['Bob','2026-02-01'],['Cara','2020-01-01'],['Dave','2026-07-01']])employees.push(await hireEmployee(ctx,{
  person:{fullName:'Fictional report '+name,primaryEmail:`composed-${name}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn,
 }));
 await transferEmployee(ctx,{employmentId:employees[0].employmentId,effectiveDate:'2026-04-01',departmentId:b.deptB});
 await terminateEmployment(ctx,{employmentId:employees[2].employmentId,terminationDate:'2026-06-01',terminationType:'voluntary'});
 await setReportingLine(ctx,{subordinateEmploymentId:employees[1].employmentId,managerEmploymentId:employees[0].employmentId,lineType:'administrative',validFrom:'2026-02-02'});
 await owner.db.update(schema.person).set({gender:'female',dateOfBirth:'1990-05-01'}).where(eq(schema.person.id,employees[0].personId));
 await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:employees[0].personId,icNumber:'900501145678',epfCitizenship:'citizen'});
 await createEntitlementTemplate(ctx,{leaveTypeId:b.annualLeaveTypeId,name:'Fictional report carry',serviceBands:[{fromYears:0,toYears:null,days:12,carryForwardDays:2}],validFrom:'2020-01-01'});
 await owner.db.insert(schema.leaveLedger).values([
  {tenantId:b.tenantId,employmentId:employees[0].employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'6.00',effectiveOn:'2025-12-31'},
  {tenantId:b.tenantId,employmentId:employees[0].employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'debit',days:'-1.00',effectiveOn:'2026-03-01'},
  {tenantId:b.tenantId,employmentId:employees[0].employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'adjustment',days:'-2.00',effectiveOn:'2026-01-01',reason:CARRY_FORFEIT_REASON_CAP},
 ]);
 return {b,ctx,employees};
}
const dataQueries=(queries:Query[])=>queries.filter(q=>!q.sql.includes('public.app_user u')&&q.sql!=='set local jit=off');
const originalEmploymentAggregate=(query:Query)=>/^select count\(\*\) from "employment" where /.test(query.sql)||
 query.sql.includes('to_char("employment"."hired_on"')||query.sql.includes('to_char("employment"."terminated_on"');
const dashboardEmploymentAggregate=(query:Query)=>query.sql.includes('analytics_turnover_leavers')||query.sql.includes('analytics_movement_event');

it('matches all thirteen public report owners and independent facts with one real RR/RO transaction',async()=>{
 const f=await fixture(),p=input(),baseline=observe();let expected:Awaited<ReturnType<typeof standaloneDashboard>>;
 try{expected=await standaloneDashboard(f.ctx,[f.b.companyId],p);}finally{baseline.restore();}
 expect(baseline.properties).toHaveLength(13);
 const candidate=observe();let result:Awaited<ReturnType<typeof analyticsDashboard>>;
 const start=performance.now();try{result=await analyticsDashboard(f.ctx,[f.b.companyId],p);}finally{candidate.restore();}
 const elapsedMs=performance.now()-start;
 expect(result!).toEqual(expected!);expect(candidate.properties).toHaveLength(1);
 expect(candidate.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});
 expect(candidate.state).toEqual({active:0,maxActive:1});
 const policy=candidate.queries.filter(q=>q.sql==='set local jit=off');expect(policy).toHaveLength(1);expect(policy[0].params).toEqual([]);
 expect(baseline.queries.filter(q=>q.sql==='set local jit=off')).toHaveLength(0);
 expect(candidate.queries.indexOf(policy[0])).toBeGreaterThan(candidate.queries.findIndex(q=>q.sql.includes('public.app_user u')));
 expect(candidate.queries.indexOf(policy[0])).toBeLessThan(candidate.queries.findIndex(q=>q.sql.includes('analytics_headcount')));
 expect(dataQueries(baseline.queries).filter(originalEmploymentAggregate)).toHaveLength(5);
 expect(dataQueries(candidate.queries).filter(dashboardEmploymentAggregate)).toHaveLength(2);
 expect(dataQueries(candidate.queries).filter(query=>!dashboardEmploymentAggregate(query)))
  .toEqual(dataQueries(baseline.queries).filter(query=>!originalEmploymentAggregate(query)));
 expect(baseline.queries.filter(q=>q.sql.includes('public.app_user u'))).toHaveLength(5);
 expect(candidate.queries.filter(q=>q.sql.includes('public.app_user u'))).toHaveLength(1);
 expect(result!.hc.total).toBe(2);expect(result!.demographics.total).toBe(2);expect(result!.masterCount).toBe(3);
 expect(result!.hires.rows.map(row=>row.name)).toEqual(['Fictional report Bob']);
 expect(result!.terms.rows.map(row=>row.name)).toEqual(['Fictional report Cara']);
 expect(result!.changeJobs.rows).toHaveLength(1);expect(result!.changeJobs.rows[0]).toMatchObject({name:'Fictional report Ann',fromDepartment:'Finance',toDepartment:'Operations'});
 expect(result!.turnover).toEqual({leavers:1,headcountStart:2,headcountEnd:2,avgHeadcount:2,turnoverPct:50});
 expect(result!.leaveUtil).toEqual([{name:'Annual Leave',granted:6,taken:1}]);expect(result!.leaveBalances).toEqual([{name:'Annual Leave',balance:3}]);
 expect(result!.sickTrend).toEqual({configured:false,series:[]});expect(result!.carryForward.state.total).toBe(4);
 expect(result!.carryForward.rows.find(row=>row.employmentId===f.employees[0].employmentId)).toMatchObject({carried:2,forfeitedAtOpen:2});
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'analytics-dashboard-composition.json'),JSON.stringify({
  kind:'NATIVE_ANALYTICS_COMPOSITION_COMPONENT_ONLY',releaseEligible:false,reportCount:13,baselineTransactions:baseline.properties.length,
  candidateTransactions:candidate.properties.length,baselineStatements:baseline.queries.length,candidateStatements:candidate.queries.length,
  equalUnaffectedNativeDataQueries:true,nativeEmploymentAggregateStatements:{baseline:5,candidate:2},exactParity:true,elapsedMs,
 },null,2));
});

it('preserves each report’s original filter semantics and exact past-end page counts',async()=>{
 const f=await fixture(),p=input();
 p.filters={companyId:f.b.companyId,departmentId:f.b.deptA,q:'Fictional report B%',managerEmploymentId:f.employees[0].employmentId};
 p.pages.hires=parsePageQuery({page:'9'});
 const expected=await standaloneDashboard(f.ctx,[f.b.companyId],p),actual=await analyticsDashboard(f.ctx,[f.b.companyId],p);
 expect(actual).toEqual(expected);
 // Headcount and company-only turnover/ledger reports deliberately retain their
 // existing filter sets; presentation composition must not silently unify them.
 expect(actual.hc.total).toBe(2);expect(actual.demographics.total).toBe(1);expect(actual.masterCount).toBe(1);
 expect(actual.hires.rows).toEqual([]);expect(actual.hires.state.total).toBe(1);expect(actual.terms.state.total).toBe(0);
 expect(actual.changeJobs.state.total).toBe(0);expect(actual.carryForward.state.total).toBe(1);
 expect(actual.leaveBalances).toEqual([{name:'Annual Leave',balance:3}]);expect(actual.turnover.turnoverPct).toBe(50);
});

it('keeps one admitted snapshot across a committed mutation between report bodies',async()=>{
 const f=await fixture(),p=input(),before=await standaloneDashboard(f.ctx,[f.b.companyId],p);let changed=false;
 const probe=observe({after:async query=>{
  if(!changed&&query.sql.includes('analytics_headcount')){
   changed=true;await owner.client.begin(async writer=>{
    await writer`set local lock_timeout='500ms'`;
    await writer`update employment set terminated_on='2026-06-15' where id=${f.employees[0].employmentId}::uuid`;
    await writer`insert into leave_ledger(tenant_id,employment_id,leave_type_id,entry_type,days,effective_on)
      values(${f.b.tenantId}::uuid,${f.employees[1].employmentId}::uuid,${f.b.annualLeaveTypeId}::uuid,'accrual',7,'2026-06-01')`;
   });
  }
 }});
 try{expect(await analyticsDashboard(f.ctx,[f.b.companyId],p)).toEqual(before);}finally{probe.restore();}
 expect(changed).toBe(true);expect(probe.properties).toHaveLength(1);
 const next=await analyticsDashboard(f.ctx,[f.b.companyId],p);
 expect(next.hc.total).toBe(1);expect(next.demographics.total).toBe(1);expect(next.masterCount).toBe(2);
 expect(next.leaveBalances).toEqual([{name:'Annual Leave',balance:10}]);
});

it('captures scope, filters and each independent page before asynchronous transaction admission',async()=>{
 const f=await fixture(),p=input(),scope=[f.b.companyId],before=await standaloneDashboard(f.ctx,scope,p);
 const pending=analyticsDashboard(f.ctx,scope,p);
 scope[0]=randomUUID();p.filters.companyId=randomUUID();p.from='2099-01-01';p.to='2099-12-31';p.year=2099;
 p.pages.hires.offset=500;p.pages.terms.limit=1;p.pages.changeJobs.page=9;p.pages.carryForward.size='all';
 expect(await pending).toEqual(before);
});

it('retains native RLS, nonadmin nationality omission, foreign fences and fresh principal refusal',async()=>{
 const f=await fixture(),userId=await createAppUser(f.b.tenantId,f.employees[1].personId,'employee');
 const employee:SessionContext={tenantId:f.b.tenantId,userId,personId:f.employees[1].personId,roles:['employee']};
 const own=await analyticsDashboard(employee,[],input());
 expect(own.hc.total).toBe(1);expect(own.hires.rows.map(row=>row.name)).toEqual(['Fictional report Bob']);expect(own.nationality).toBeNull();
 const foreign=await seedBase();expect((await analyticsDashboard(f.ctx,[foreign.companyId],input())).hc.total).toBe(0);
 await expect(analyticsDashboard({...f.ctx,personId:randomUUID()},[f.b.companyId],input())).rejects.toThrow('calling authority');
 await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,f.b.adminUserId));
 await expect(analyticsDashboard(f.ctx,[f.b.companyId],input())).rejects.toThrow('calling authority');
});

it('completes behind an open Access writer without audit writes and PostgreSQL enforces read-only mode',async()=>{
 const f=await fixture(),actual=database.withTenant;
 const [before]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${f.b.tenantId}::uuid`;
 const bounds=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);return read(tx);
 },options));
 try{await owner.client.begin(async writer=>{
  await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+f.b.tenantId},0))`;
  expect((await analyticsDashboard(f.ctx,[f.b.companyId],input())).hc.total).toBe(2);
 });}finally{bounds.mockRestore();}
 const [after]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${f.b.tenantId}::uuid`;expect(after).toEqual(before);
 const probe=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(ctx,async tx=>{
  await tx.update(schema.company).set({legalName:'Must not persist'}).where(eq(schema.company.id,f.b.companyId));return read(tx);
 },options));
 try{
  let failure:unknown;try{await analyticsDashboard(f.ctx,[f.b.companyId],input());}catch(error){failure=error;}
  const messages=[];while(failure instanceof Error){messages.push(failure.message);failure=(failure as Error&{cause?:unknown}).cause;}
  expect(messages.join(' | ')).toMatch(/read-only transaction/i);
 }finally{probe.mockRestore();}
 expect((await owner.db.select({name:schema.company.legalName}).from(schema.company).where(eq(schema.company.id,f.b.companyId)))[0].name).toBe('Acme Sdn Bhd');
});

it('settles the original report failure before starting another borrowed reader',async()=>{
 const f=await fixture(),failure=Error('Controlled native report failure');
 const probe=observe({fail:{matches:query=>query.sql.includes('analytics_newHires_page'),error:failure}});
 try{await expect(analyticsDashboard(f.ctx,[f.b.companyId],input())).rejects.toBe(failure);}finally{probe.restore();}
 expect(probe.queries.some(query=>query.sql.includes('analytics_headcount'))).toBe(true);
 expect(probe.queries.some(query=>query.sql.includes('analytics_newHires_page'))).toBe(true);
 expect(probe.queries.some(query=>query.sql.includes('analytics_terminations_page'))).toBe(false);
 expect(probe.state).toEqual({active:0,maxActive:1});expect(probe.properties).toHaveLength(1);
});


it('preserves all thirteen DTOs behind held Access for empty, nonempty and past-end change-job envelopes',async()=>{
 const f=await fixture();
 const [before]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${f.b.tenantId}::uuid`;
 for(const kind of ['empty','nonempty','past-end']as const){
  const p=input();if(kind==='empty')p.filters.q='Definitely absent';
  if(kind==='past-end')p.pages.changeJobs=parsePageQuery({page:'99'});
  const expected=await standaloneDashboard(f.ctx,[f.b.companyId],p),probe=observe();
  try{await owner.client.begin(async writer=>{
   await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+f.b.tenantId},0))`;
   const actual=await analyticsDashboard(f.ctx,[f.b.companyId],p);
   expect(actual).toEqual(expected);expect(Object.keys(actual)).toHaveLength(13);
   expect(actual.changeJobs.rows).toHaveLength(kind==='nonempty'?1:0);
   expect(actual.changeJobs.state.total).toBe(kind==='empty'?0:1);
  });}finally{probe.restore();}
  expect(probe.properties).toHaveLength(1);expect(probe.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});
  const statements=probe.queries.filter(query=>query.sql.includes('analytics_changeJobTransactions_page'));
  expect(statements).toHaveLength(1);expect(statements[0].rows).toBe(1);expect(probe.state).toEqual({active:0,maxActive:1});
 }
 const [after]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${f.b.tenantId}::uuid`;
 expect(after).toEqual(before);
});

it('settles change-job envelope failure before later reports and releases its native presentation owner',async()=>{
 const f=await fixture(),failure=Error('Controlled change-job envelope failure');
 const probe=observe({fail:{matches:query=>query.sql.includes('analytics_changeJobTransactions_page'),error:failure}});
 try{await expect(analyticsDashboard(f.ctx,[f.b.companyId],input())).rejects.toBe(failure);}finally{probe.restore();}
 expect(probe.queries.filter(query=>query.sql.includes('analytics_changeJobTransactions_page'))).toHaveLength(1);
 expect(probe.queries.some(query=>query.sql.includes('"date_of_birth"'))).toBe(false);
 expect(probe.state).toEqual({active:0,maxActive:1});expect(probe.properties).toHaveLength(1);
 const expected=await standaloneDashboard(f.ctx,[f.b.companyId],input());
 expect(await analyticsDashboard(f.ctx,[f.b.companyId],input())).toEqual(expected);
});

it('settles native carry cursor failure before starting the later master report',async()=>{
 const f=await fixture(),actual=database.withTenant,dialect=new PgDialect(),queries:string[]=[];
 const properties:{role:string;isolation:string;readOnly:boolean;pid:number}[]=[],state={active:0,maxActive:0};
 let controlClosed=false,originalFetchFailure:unknown,caught:unknown;
 const run=async<T>(text:string,work:()=>PromiseLike<T>):Promise<T>=>{
  queries.push(text);state.active++;state.maxActive=Math.max(state.maxActive,state.active);
  try{return await work();}finally{state.active--;}
 };
 // Observe builder execution as well as public execute so the later master-count
 // assertion cannot pass merely because that query used a different API.
 const wrap=(query:object):object=>new Proxy(query,{get(target,key,receiver){
  const value=Reflect.get(target,key,receiver);
  if(key==='then'&&typeof value==='function')return (resolve:(rows:unknown)=>unknown,reject:(error:unknown)=>unknown)=>{
   const text=(target as {toSQL:()=>{sql:string}}).toSQL().sql;
   return run(text,()=>Promise.resolve(Reflect.apply(value,target,[(rows:unknown)=>rows]))).then(resolve,reject);
  };
  return typeof value==='function'?(...args:unknown[])=>{
   const result=Reflect.apply(value,target,args);return result&&typeof result==='object'&&'then'in result?wrap(result):result;
  }:value;
 }});
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  const [facts]=await tx.execute<{role:string;isolation:string;readOnly:boolean;pid:number}>(sql`select current_user as role,
   current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')='on'as "readOnly",pg_backend_pid()as pid`);
  properties.push(facts);
  return read(new Proxy(tx,{get(target,key,receiver){
   if(key==='select'||key==='selectDistinct')return (...args:unknown[])=>wrap(Reflect.apply(target[key],target,args));
   if(key==='execute')return (statement:SQL)=>{
    const text=dialect.sqlToQuery(statement).sql;
    return run(text,async()=>{
     let result:Awaited<ReturnType<Tx['execute']>>;
     try{result=await target.execute(statement);}catch(error){
      if(text.trim().toLowerCase()==='fetch forward 4096 from analytics_carry_identities')originalFetchFailure=error;
      throw error;
     }
     if(text.trim().toLowerCase().startsWith('declare analytics_carry_identities ')){
      // The production DECLARE succeeds first. Only this test's own live cursor
      // is closed; the first unchanged production FETCH then genuinely fails.
      await target.execute(sql`close analytics_carry_identities`);controlClosed=true;
     }
     return result;
    });
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }}));
 },options));
 try{await analyticsDashboard(f.ctx,[f.b.companyId],input());}catch(error){caught=error;}finally{spy.mockRestore();}
 expect(controlClosed).toBe(true);expect(originalFetchFailure).toBeDefined();expect(caught).toBe(originalFetchFailure);expect(pgSqlState(caught)).toBe('34000');
 expect(queries.filter(query=>query.trim().toLowerCase()==='fetch forward 4096 from analytics_carry_identities')).toHaveLength(1);
 expect(queries.some(query=>query.includes('analytics_master_count'))).toBe(false);
 expect(queries.some(query=>query.includes('"date_of_birth"'))).toBe(true);
 expect(state).toEqual({active:0,maxActive:1});expect(properties).toHaveLength(1);
 expect(properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});
 const activity=await owner.client<{state:string;xactStart:string|null}[]>`select state,xact_start as "xactStart" from pg_stat_activity where pid=${properties[0].pid}`;
 expect(activity.length).toBeLessThanOrEqual(1);if(activity.length)expect(activity[0]).toMatchObject({state:'idle',xactStart:null});
 const expected=await standaloneDashboard(f.ctx,[f.b.companyId],input());
 expect(await analyticsDashboard(f.ctx,[f.b.companyId],input())).toEqual(expected);
});
