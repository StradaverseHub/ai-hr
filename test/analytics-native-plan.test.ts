/** Hosted disposable-database diagnostic. Captures actual canonical SQL objects,
 * not a separately rewritten query, and never changes policies or runtime code. */
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {sql,SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {analyticsManagerSelection,headcountSummaryTx,masterDataCount,newHiresPage,terminationsPage} from '../core/analytics';
import {parsePageQuery} from '../lib/pagination';
import {pgSqlState} from '../lib/db-error';
import {closeAll,migrateTestDb,owner} from './harness';
import {workerDb} from './db-names';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';

const file='test/analytics-native-plan.test.ts';
const selection:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selection)&&selection.length===1&&selection[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);

type Statement={phase:string;sql:string;parameterCount:number;parameterKinds:string[];estimated?:unknown;analyzed?:unknown;
 actualMs?:number;returnedRows?:number;firstRow?:unknown;lastRow?:unknown;failure?:{message:string;code:string|null};stage:string};
const errorDetails=(error:unknown)=>({message:error instanceof Error?error.message:'Unknown diagnostic failure',code:pgSqlState(error)??null});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function nativeSecurityFingerprint(){
 const policies=Array.from(await owner.client`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
  from pg_policies where schemaname in ('public','app') order by schemaname,tablename,policyname`);
 const functions=Array.from(await owner.client`select p.oid::regprocedure::text as signature,md5(p.prosrc) as body,
  p.proowner::regrole::text as owner,p.proacl::text as acl,p.proconfig as settings,p.prosecdef,p.provolatile,p.proparallel
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='app' order by p.oid::regprocedure::text`);
 return {policies:digest(policies),functions:digest(functions)};
}

it.skipIf(!requested)('explains real Analytics page statements under one native calling-principal app backend',async()=>{
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 expect(poolId).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){
  const target=new URL(process.env[key]!);expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/'+workerDb(poolId!));
 }
 const report:Record<string,unknown>={kind:'DISPOSABLE_NATIVE_ANALYTICS_SQL_PLAN_DIAGNOSTIC',releaseEligible:false,employees:50000,
  host:{logicalCpus:cpus().length,cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],ramBytes:totalmem()},
  limits:{maxAppConnections:1,maximumStatementTimeoutMs:20000,maximumLockTimeoutMs:300,testBudgetMs:300000},
  limitations:'Component-only fictional-data diagnostic. EXPLAIN repeats reads in the same snapshot and affects warmth; timings are not an independent production comparison.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'analytics-native-plan.json'),JSON.stringify(report,null,2));
 const {b,ctx,foreign,foreignEmployment,expectedLast}=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
 const originalSecurity=await nativeSecurityFingerprint();report.originalSecurity=originalSecurity;
 // The fixture used the ordinary app pool once. This selected-only file owns that
 // pool; close it before measuring so the probe has one actual app backend.
 await database.client.end({timeout:5});
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','analytics_native_plan_probe');
 const single=database.createDb(url.toString(),{max:1});expect(single.client.options.max).toBe(1);
 const dialect=new PgDialect(),pids=new Set<number>(),connections=new Set<number>();
 const statements:Statement[]=[],identities:unknown[]=[],wireStatements:unknown[]=[],outcomes:{phase:string;ok:boolean;ms:number;failure?:unknown}[]=[];
 report.statements=statements;report.identities=identities;report.wireStatements=wireStatements;report.outcomes=outcomes;
 let phase='setup';
 const previousDebug=single.client.options.debug;
 single.client.options.debug=(connection:number,query:string,parameters:unknown[],paramTypes:unknown[])=>{
  connections.add(connection);wireStatements.push({phase,connection,sql:query,parameterCount:parameters.length,paramTypes});save();
 };
 const fluent=new Set(['from','innerJoin','leftJoin','rightJoin','fullJoin','where','groupBy','having','orderBy','limit','offset','$dynamic']);
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>
  single.withTenant(context,async tx=>{
   // Only tighten existing limits: a zero PostgreSQL timeout means unlimited.
   const [before]=await tx.execute<{statementMs:number;lockMs:number}>(sql`select
    (select setting::int from pg_settings where name='statement_timeout')as "statementMs",
    (select setting::int from pg_settings where name='lock_timeout')as "lockMs"`);
   if(before.statementMs===0||before.statementMs>20000)await tx.execute(sql`set local statement_timeout='20s'`);
   if(before.lockMs===0||before.lockMs>300)await tx.execute(sql`set local lock_timeout='300ms'`);
   const [identity]=await tx.execute<{role:string;pid:number;tenant:string;user:string;employmentRls:boolean;assignmentRls:boolean;personRls:boolean;companyRls:boolean;readOnly:string;isolation:string;statementMs:number;lockMs:number;workMem:string;hashMultiplier:string}>(sql`
    select current_user as role,pg_backend_pid()as pid,app.current_tenant_id()as tenant,app.current_user_id()as "user",
     row_security_active('public.employment'::regclass)as "employmentRls",row_security_active('public.assignment'::regclass)as "assignmentRls",
     row_security_active('public.person'::regclass)as "personRls",row_security_active('public.company'::regclass)as "companyRls",
     current_setting('transaction_read_only')as "readOnly",current_setting('transaction_isolation')as isolation,
     (select setting::int from pg_settings where name='statement_timeout')as "statementMs",
     (select setting::int from pg_settings where name='lock_timeout')as "lockMs",
     current_setting('work_mem')as "workMem",current_setting('hash_mem_multiplier')as "hashMultiplier"`);
   expect(identity).toMatchObject({role:'ai_hr_app',tenant:context.tenantId,user:context.userId,employmentRls:true,assignmentRls:true,personRls:true,companyRls:true,readOnly:'on',isolation:'repeatable read'});
   expect(identity.statementMs).toBeGreaterThan(0);expect(identity.statementMs).toBeLessThanOrEqual(20000);
   expect(identity.lockMs).toBeGreaterThan(0);expect(identity.lockMs).toBeLessThanOrEqual(300);
   pids.add(identity.pid);identities.push({phase,...identity});save();
   async function observe(query:SQL,work:()=>Promise<unknown>){
    const compiled=dialect.sqlToQuery(query),entry:Statement={phase,sql:compiled.sql,parameterCount:compiled.params.length,
     parameterKinds:compiled.params.map(value=>value===null?'null':Array.isArray(value)?'array':typeof value),stage:'prepared'};
    statements.push(entry);save();
    // Principal SQL is observed but its existence query is not a report plan.
    const explain=/^\s*select\b/i.test(compiled.sql)&&!compiled.sql.includes('app.principal_snapshot_current()');
    try{
     if(explain){entry.stage='estimated-plan';entry.estimated=Array.from(await tx.execute(sql`explain(format json) ${query}`));save();}
     entry.stage='actual-port-statement';const start=performance.now();
     let result:unknown;
     try{result=await work();}finally{entry.actualMs=performance.now()-start;save();}
     if(Array.isArray(result)){
      entry.returnedRows=result.length;
      // Only fictional fixture values; output samples are limited to the true
      // first/last row rather than retaining an entire report in diagnostics.
      entry.firstRow=result[0]??null;entry.lastRow=result.at(-1)??null;
     }
     if(explain){entry.stage='analyzed-plan';entry.analyzed=Array.from(await tx.execute(sql`explain(analyze,buffers,timing off,format json) ${query}`));save();}
     entry.stage='complete';save();return result;
    }catch(error){entry.failure=errorDetails(error);save();throw error;}
   }
   function wrappedSelect(target:object):object{
    return new Proxy(target,{get(object,key,receiver){
     const value=Reflect.get(object,key,receiver);
     if(key==='then'&&typeof value==='function')return (fulfilled?:(result:unknown)=>unknown,rejected?:(error:unknown)=>unknown)=>{
      const getSQL=Reflect.get(object,'getSQL');
      if(typeof getSQL!=='function')throw Error('Native select statement does not expose its canonical SQL object');
      const query:unknown=Reflect.apply(getSQL,object,[]);
      if(!(query instanceof SQL))throw Error('Native select did not return a SQL object');
      return observe(query,()=>Promise.resolve(object)).then(fulfilled,rejected);
     };
     if(typeof value==='function')return(...args:unknown[])=>{
      const next:unknown=Reflect.apply(value,object,args);
      return fluent.has(String(key))&&typeof next==='object'&&next!==null?wrappedSelect(next):next;
     };
     return value;
    }});
   }
   return read(new Proxy(tx,{get(target,key,receiver){
    const value=Reflect.get(target,key,receiver);
    if(key==='select'&&typeof value==='function')return(...args:unknown[])=>{
     const builder:unknown=Reflect.apply(value,target,args);
     if(typeof builder!=='object'||builder===null)throw Error('Native select builder unavailable');
     return wrappedSelect(builder);
    };
    if(key==='execute')return(query:SQL)=>observe(query,()=>target.execute(query));
    return typeof value==='function'?value.bind(target):value;
   }}));
  },options));
 const run=async(name:string,read:()=>Promise<unknown>,verify:(value:unknown)=>void)=>{
  phase=name;report.phase=phase;save();const start=performance.now();
  try{const result=await read();verify(result);outcomes.push({phase,ok:true,ms:performance.now()-start});}
  catch(error){outcomes.push({phase,ok:false,ms:performance.now()-start,failure:errorDetails(error)});}
  save();
 };
 const page=parsePageQuery(),hired={from:'2020-01-01',to:'2020-12-31'},ended={from:'2024-01-01',to:'2024-12-31'};
 const firstTerms=Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String((i+1)*5).padStart(9,'0'));
 try{
  await run('termination-first',()=>terminationsPage(ctx,[b.companyId],{...ended,page}),value=>{
   const result=value as Awaited<ReturnType<typeof terminationsPage>>;
   expect(result.state.total).toBe(10000);expect(result.rows.map(row=>row.name)).toEqual(firstTerms);
   expect(result.rows.every(row=>row.department==='Finance'&&row.terminatedOn==='2024-01-01')).toBe(true);
  });
  await run('termination-point',()=>terminationsPage(ctx,[b.companyId],{...ended,filter:{q:'000050000'},page}),value=>{
   const result=value as Awaited<ReturnType<typeof terminationsPage>>;
   expect(result.state.total).toBe(1);expect(result.rows.map(row=>row.name)).toEqual(['Fictional retained Personnel 000050000']);
  });
  await run('termination-empty',()=>terminationsPage(ctx,[b.companyId],{...ended,filter:{q:'Fictional definitely absent'},page}),value=>{
   const result=value as Awaited<ReturnType<typeof terminationsPage>>;expect(result.state.total).toBe(0);expect(result.rows).toEqual([]);
  });
  await run('termination-deep',()=>terminationsPage(ctx,[b.companyId],{...ended,page:parsePageQuery({page:'399'})}),value=>{
   const result=value as Awaited<ReturnType<typeof terminationsPage>>;
   expect(result.state.total).toBe(10000);expect(result.rows).toHaveLength(25);expect(result.rows.at(-1)?.name).toBe('Fictional retained Personnel 000050000');
  });
  await run('termination-company-negative',()=>terminationsPage(ctx,[foreign.companyId],{...ended,page}),value=>{
   const result=value as Awaited<ReturnType<typeof terminationsPage>>;expect(result.state.total).toBe(0);expect(result.rows).toEqual([]);
  });
  await run('hire-first',()=>newHiresPage(ctx,[b.companyId],{...hired,page}),value=>{
   const result=value as Awaited<ReturnType<typeof newHiresPage>>;expect(result.state.total).toBe(50000);expect(result.rows).toHaveLength(25);
   expect(result.rows.map(row=>row.name)).toEqual(Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String(i+1).padStart(9,'0')));
  });
  await run('master-count',()=>masterDataCount(ctx,[b.companyId]),value=>expect(value).toBe(40000));
  await run('selected-manager',()=>analyticsManagerSelection(ctx,[b.companyId],expectedLast.at(-1)),value=>
   expect(value).toEqual({employmentId:expectedLast.at(-1),name:'Fictional retained Personnel 000050000'}));
  await run('selected-manager-foreign',()=>analyticsManagerSelection(ctx,[],foreignEmployment),value=>expect(value).toBeNull());
  await run('headcount-tx',()=>database.withTenant(ctx,async tx=>{
   await assertAiPresentationPrincipalTx(tx,ctx);return headcountSummaryTx(tx,[b.companyId],{asOf:'2026-01-01'});
  },{readOnlySnapshot:true}),value=>expect(value).toEqual({total:40000,byCompany:[{name:'Acme Sdn Bhd',count:40000}],byDepartment:[{name:'Finance',count:40000}],byPosition:[{name:'—',count:40000}]}));
 }finally{
  spy.mockRestore();single.client.options.debug=previousDebug;
  report.finalSecurity=await nativeSecurityFingerprint();report.securityUnchanged=digest(report.finalSecurity)===digest(originalSecurity);
  report.appBackendPids=[...pids];report.wireConnectionIds=[...connections];report.phase='complete';report.complete=true;save();
 }
 expect(report.securityUnchanged).toBe(true);expect(pids.size).toBe(1);expect(connections.size).toBe(1);
 expect(statements.some(row=>row.phase==='termination-first'&&row.estimated)).toBe(true);
 expect(statements.some(row=>row.phase==='termination-first'&&row.analyzed)).toBe(true);
 expect(outcomes.filter(row=>!row.ok)).toEqual([]);
},300000);
