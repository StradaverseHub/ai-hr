/** Hosted fictional-data baseline. No production read or calculation is changed. */
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {availableParallelism,totalmem} from 'node:os';
import {eq,sql,SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as schema from '../db/schema';
import {leaveInquiryContext,leaveInquiryBalancePairs,leaveInquiryRecordsPage,leaveInquirySnapshot} from '../core/leave-inquiry';
import {inquiryBalancePage} from '../app/leave/employee-balances/inquiry-data';
import {hireEmployee} from '../core/org';
import {parseInquiryQuery,InquiryQueryError} from '../lib/leave-inquiry-query';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {workerDb} from './db-names';

const file='test/leave-inquiry-read-cost.test.ts';
const selection:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selection)&&selection.length===1&&selection[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const errorDetails=(error:unknown)=>({name:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message:'unknown',sqlState:pgSqlState(error)??null});
function assertHostedFixture(){
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(poolId).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){
  const target=new URL(process.env[key]!);expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/'+workerDb(poolId!));
 }
}
async function barrier<T>(work:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Controlled writer did not reach its barrier')),5000);})]);}
 finally{if(timer)clearTimeout(timer);}
}

function recorder(kind:string){
 const report:Record<string,unknown>={kind,releaseEligible:false,measurementStage:'presentation-candidate',comparedToBaselineSource:'d0ee92473a88435951d7928c9bb0ac7556fa3483',
  source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).trim(),host:{cpus:availableParallelism(),ramBytes:totalmem()},
  limitations:'Fictional component baseline, not production capacity. Statement observations and result-byte serialization add overhead. Estimated plans do not replay actual reads.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,kind+'.json'),JSON.stringify(report,null,2));
 return {report,save};
}

type Statement={phase:string;sql:string;parameters:number;ms?:number;rows?:number;resultBytes?:number;columns?:string[];plan?:unknown;failure?:ReturnType<typeof errorDetails>};
function observeTransactions(report:Record<string,unknown>,save:()=>void,phase:()=>string){
 const original=database.withTenant,dialect=new PgDialect(),statements:Statement[]=[],identities:unknown[]=[],planned=new Set<string>();
 report.statements=statements;report.identities=identities;
 const fluent=new Set(['from','innerJoin','leftJoin','leftJoinLateral','rightJoin','fullJoin','where','groupBy','having','orderBy','limit','offset','$dynamic']);
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>original(ctx,async tx=>{
  const [limits]=await tx.execute<{statementMs:number;lockMs:number}>(sql`select
   (select setting::int from pg_settings where name='statement_timeout') as "statementMs",
   (select setting::int from pg_settings where name='lock_timeout') as "lockMs"`);
  // Tighten only. Never raise a production/default request or statement budget.
  if(limits.statementMs===0||limits.statementMs>20000)await tx.execute(sql`set local statement_timeout='20s'`);
  if(limits.lockMs===0||limits.lockMs>300)await tx.execute(sql`set local lock_timeout='300ms'`);
 const [identity]=await tx.execute<{role:string;tenant:string;user:string;pid:number;readonly:string;isolation:string;employment:boolean;person:boolean;statementTimeout:string;lockTimeout:string}>(sql`
   select current_user as role,app.current_tenant_id() as tenant,app.current_user_id() as "user",pg_backend_pid() as pid,
    current_setting('transaction_read_only') as readonly,current_setting('transaction_isolation') as isolation,
    row_security_active('employment'::regclass) as employment,row_security_active('person'::regclass) as person,
    current_setting('statement_timeout') as "statementTimeout",current_setting('lock_timeout') as "lockTimeout"`);
  expect(identity).toMatchObject({role:'ai_hr_app',tenant:ctx.tenantId,user:ctx.userId,employment:true,person:true});
  identities.push({phase:phase(),...identity});save();
  async function observed(query:SQL,work:()=>Promise<unknown>){
   const compiled=dialect.sqlToQuery(query),entry:Statement={phase:phase(),sql:compiled.sql,parameters:compiled.params.length};
   statements.push(entry);save();
   const employeeProjection=compiled.sql.includes('"employment"."card_id"')||compiled.sql.includes('as "businessUnit"');
   const planKind=employeeProjection?'employee-population':
    compiled.sql.includes('"person"."gender"')&&compiled.sql.includes('"employment"."org_division"')?'eligibility-profile':null;
   try{
    if(planKind&&!planned.has(planKind)){
     planned.add(planKind);entry.plan=Array.from(await tx.execute(sql`explain(format json) ${query}`));save();
    }
    const start=performance.now();let result:unknown;
    try{result=await work();}finally{entry.ms=performance.now()-start;save();}
    if(Array.isArray(result)){
     entry.rows=result.length;entry.resultBytes=bytes(result);
     if(result[0]&&typeof result[0]==='object')entry.columns=Object.keys(result[0]);
    }
    save();return result;
   }catch(error){entry.failure=errorDetails(error);save();throw error;}
  }
  function selectProxy(target:object):object{
   return new Proxy(target,{get(object,key,receiver){
    const value=Reflect.get(object,key,receiver);
    if(key==='then'&&typeof value==='function')return(fulfilled?:(value:unknown)=>unknown,rejected?:(error:unknown)=>unknown)=>{
     const getSQL=Reflect.get(object,'getSQL');if(typeof getSQL!=='function')throw Error('Missing native query SQL');
     const query:unknown=Reflect.apply(getSQL,object,[]);if(!(query instanceof SQL))throw Error('Missing SQL object');
     return observed(query,()=>Promise.resolve(object)).then(fulfilled,rejected);
    };
    if(typeof value==='function')return(...args:unknown[])=>{
     const next:unknown=Reflect.apply(value,object,args);
     return fluent.has(String(key))&&next!==null&&typeof next==='object'?selectProxy(next):next;
    };
    return value;
   }});
  }
  return read(new Proxy(tx,{get(target,key,receiver){
   const value=Reflect.get(target,key,receiver);
   if(key==='select'||key==='selectDistinct')return(...args:unknown[])=>{
    if(typeof value!=='function')throw Error('Missing native select');
    const builder:unknown=Reflect.apply(value,target,args);if(!builder||typeof builder!=='object')throw Error('Missing builder');
    return selectProxy(builder);
   };
   if(key==='execute')return(query:SQL)=>observed(query,()=>target.execute(query));
   return typeof value==='function'?value.bind(target):value;
  }}));
 },options));
 return {statements,identities,restore:()=>spy.mockRestore()};
}

it.skipIf(!requested)('records native snapshot usability while actual Access and History writers remain held',async()=>{
 assertHostedFixture();
 await resetDb();const b=await seedBase(),ctx={...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]},today=todayInKualaLumpur();
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional Leave snapshot subject',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'LEAVE-A',employmentType:'full_time',hiredOn:'2020-01-01'});
 await owner.db.insert(schema.leaveLedger).values([
  {tenantId:b.tenantId,employmentId:hired.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'12',effectiveOn:today},
  {tenantId:b.tenantId,employmentId:hired.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'debit',days:'-2',effectiveOn:today},
 ]);
 await owner.db.insert(schema.leaveRequest).values({tenantId:b.tenantId,employmentId:hired.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:today,endDate:today,days:'1',status:'pending'});
 const {report,save}=recorder('leave-inquiry-native-control-baseline');let phase='controls';
 const observation=observeTransactions(report,save,()=>phase),outcomes:unknown[]=[];report.outcomes=outcomes;
 try{
  for(const lock of ['access-configuration:','payroll-history:']){
   let entered!:()=>void,release!:()=>void;const held=new Promise<void>(resolve=>{entered=resolve;}),unblock=new Promise<void>(resolve=>{release=resolve;});
   const writer=owner.client.begin(async tx=>{await tx`select pg_advisory_xact_lock(hashtextextended(${lock+b.tenantId},0))`;entered();await unblock;});
   try{
    await barrier(Promise.race([held,writer.then(()=>{throw Error('Controlled writer ended before the read');})]));phase=lock;const start=performance.now(),query=parseInquiryQuery({emp:hired.employmentId,type:b.annualLeaveTypeId,asOf:today},'balances');
    const page=await leaveInquirySnapshot(ctx,[b.companyId],query,(tx,scope)=>inquiryBalancePage(ctx,scope,query,'en',query.pq,tx));
    expect(page.total).toBe(1);expect(page.rows).toHaveLength(1);expect(page.rows[0].employee.employmentId).toBe(hired.employmentId);
    expect(page.rows[0].balance).toBe(10);expect(page.rows[0].available).toBe(9);
    outcomes.push({lock,readFinishedBeforeWriterReleased:true,ms:performance.now()-start});save();
   }finally{release();await writer;}
  }
  phase='native-read-only';const query=parseInquiryQuery({emp:hired.employmentId,asOf:today},'balances');
  await expect(leaveInquirySnapshot(ctx,[b.companyId],query,tx=>tx.update(schema.company).set({legalName:'Must not persist'}).where(eq(schema.company.id,b.companyId)))).rejects.toSatisfy(error=>pgSqlState(error)==='25006');
  expect((await owner.db.select().from(schema.company).where(eq(schema.company.id,b.companyId)))[0].legalName).toBe('Acme Sdn Bhd');
  phase='committed-revocation';const removed=await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId)).returning();expect(removed).toHaveLength(1);
  try{
   await expect(leaveInquiryContext(ctx,[b.companyId],parseInquiryQuery({asOf:today},'balances'))).rejects.toBeInstanceOf(InquiryQueryError);
   const protectedReads=observation.statements.filter(row=>row.phase===phase&&/\bfrom\s+"(?:employment|person|company)"/i.test(row.sql));
   expect(protectedReads).toEqual([]);report.revocation={refused:true,protectedDataQueries:protectedReads.length};
  }finally{await owner.db.insert(schema.roleAssignment).values(removed);}
  expect(observation.identities.every(value=>(value as {readonly:string}).readonly==='on'||(value as {phase:string}).phase==='committed-revocation')).toBe(true);
  report.complete=true;save();
 }catch(error){report.failure=errorDetails(error);save();throw error;}
 finally{observation.restore();save();}
},300000);

it.skipIf(!requested)('measures actual 5000-employee context, exact pair paging and canonical page hydration without changing policy',async()=>{
 assertHostedFixture();
 const {report,save}=recorder('leave-inquiry-read-cost-baseline');report.employees=5000;
 report.appPoolMaximum=database.client.options.max;
 let phase='fixture';const fixture=await seedPersonnelNativeFixture(5000,report,name=>{phase=name;report.phase=name;save();},save);
 const {b,ctx,expectedFirst,expectedLast}=fixture,today=todayInKualaLumpur();
 const extra=await owner.db.insert(schema.leaveType).values(Array.from({length:7},(_,i)=>({tenantId:b.tenantId,code:'COST'+i,name:'Fictional inquiry type '+i,visibleToEmployee:i!==0}))).returning({id:schema.leaveType.id,code:schema.leaveType.code});
 const types=[{id:b.annualLeaveTypeId,code:'ANNUAL'},...extra];report.leaveTypes=types.length;
 const policies=Array.from(await owner.client`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname in ('public','app') order by schemaname,tablename,policyname`);
 report.policyFingerprint=createHash('sha256').update(JSON.stringify(policies)).digest('hex');
 const employmentPolicy=policies.find(row=>row.tablename==='employment'&&row.policyname==='employment_rls');
 expect(String(employmentPolicy?.qual)).toMatch(/id = ANY|id IN \( SELECT unnest/);
 report.includesProductionMigration3001=String(employmentPolicy?.qual).includes('id IN ( SELECT unnest');
 report.employmentPolicy=employmentPolicy;save();
 const observation=observeTransactions(report,save,()=>phase),timings:Record<string,number>={};report.timings=timings;
 async function measured<T>(name:string,read:()=>Promise<T>){phase=name;report.phase=name;save();const start=performance.now();try{return await read();}finally{timings[name]=performance.now()-start;save();}}
 try{
  const query=parseInquiryQuery({asOf:today},'balances');
  const scope=await measured('context-all',()=>leaveInquiryContext(ctx,[b.companyId],query));
  expect(scope.employees).toHaveLength(5000);expect(scope.employees.slice(0,25).map(row=>row.employmentId)).toEqual(expectedFirst);
  expect(Object.keys(scope.employees[0]).sort()).toEqual(['employmentId','name','employeeCode','company','companyId','department','departmentId','businessUnit','businessUnitId','terminatedOn'].sort());
  report.contextBytes=bytes(scope);report.employeeDtoFieldCount=Object.keys(scope.employees[0]).length;
  const selectedQuery=parseInquiryQuery({emp:expectedLast.at(-1),asOf:today},'balances');
  const selected=await measured('context-single',()=>leaveInquiryContext(ctx,[b.companyId],selectedQuery));
  expect(selected.selected?.employmentId).toBe(expectedLast.at(-1));expect(selected.employees).toHaveLength(5000);report.selectedContextBytes=bytes(selected);save();
  const first=await measured('balance-pairs-first',()=>leaveInquiryBalancePairs(ctx,scope,query,'en'));
  expect(first.total).toBe(40000);expect(first.rows).toHaveLength(50);
  const expected=expectedFirst.slice(0,7).flatMap(employmentId=>types.map(type=>({employmentId,leaveTypeId:type.id,code:type.code})));
  expect(first.rows.map(row=>({employmentId:row.employee.employmentId,leaveTypeId:row.leaveTypeId,code:row.code}))).toEqual(expected.slice(0,50));
  report.firstPairPageBytes=bytes(first);
  const deep=await measured('balance-pairs-deep',()=>leaveInquiryBalancePairs(ctx,scope,query,'en',{limit:50,offset:39950}));
  expect(deep.total).toBe(40000);expect(deep.rows).toHaveLength(50);expect(deep.rows.at(-1)?.employee.employmentId).toBe(expectedLast.at(-1));
  const recordQuery=parseInquiryQuery({asOf:today},'records'),recordsScope=await measured('records-context',()=>leaveInquiryContext(ctx,[b.companyId],recordQuery));
  const records=await measured('records-page',()=>leaveInquiryRecordsPage(ctx,recordsScope,recordQuery));expect(records).toEqual({rows:[],total:0});
  const hydrated=await measured('snapshot-selected-hydration',()=>leaveInquirySnapshot(ctx,[b.companyId],selectedQuery,(tx,owned)=>inquiryBalancePage(ctx,owned,selectedQuery,'en',selectedQuery.pq,tx)));
  expect(hydrated.total).toBe(8);expect(hydrated.rows).toHaveLength(8);expect(hydrated.rows.every(row=>row.employee.employmentId===expectedLast.at(-1))).toBe(true);
  report.hydratedSelectedBytes=bytes(hydrated);report.complete=true;report.phase='complete';save();
 }catch(error){report.failure=errorDetails(error);save();throw error;}
 finally{
  observation.restore();
  const after=Array.from(await owner.client`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname in ('public','app') order by schemaname,tablename,policyname`);
  report.policyUnchanged=JSON.stringify(policies)===JSON.stringify(after);save();expect(report.policyUnchanged).toBe(true);
  const phases=[...new Set(observation.statements.map(row=>row.phase))];
  report.queryCountsByPhase=Object.fromEntries(phases.map(name=>[name,observation.statements.filter(row=>row.phase===name).length]));
  report.employeeProjectionReads=observation.statements.filter(row=>row.sql.includes('"employment"."card_id"')||row.sql.includes('as "businessUnit"')).map(row=>({phase:row.phase,rows:row.rows,ms:row.ms,resultBytes:row.resultBytes,columns:row.columns?.length}));
  report.leaveTypeReadsByPhase=Object.fromEntries(phases.map(name=>[name,observation.statements.filter(row=>row.phase===name&&/from "leave_type"(?:\s|$)/.test(row.sql)).length]));save();
 }
},300000);
