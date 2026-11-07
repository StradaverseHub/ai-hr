/** Hosted disposable-database diagnostic. Captures actual canonical SQL objects,
 * not a separately rewritten query, and never changes policies or runtime code. */
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {and,desc,eq,gte,ilike,inArray,isNull,lte,or,sql,SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {terminations,terminationsPage,type ReportFilter} from '../core/analytics';
import {assignment,company,department,employment,person} from '../db/schema';
import {hireEmployee,transferEmployee} from '../core/org';
import {pageState,parsePageQuery,type PageQuery} from '../lib/pagination';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {workerDb} from './db-names';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';

const file='test/analytics-termination-lateral.test.ts';
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

// Test-only predecessor copied from qualified source 01d44d3f32aac2c889abfd9ba676774eabcafc80.
// It deliberately retains the bad ordinary join, never a selectable runtime path.
type FrozenPeriodInput={from:string;to:string;filter?:ReportFilter};
const scopeWhere=(scopeIds:string[]|undefined)=>scopeIds&&scopeIds.length?inArray(employment.companyId,scopeIds):undefined;
const qWhere=(filter:ReportFilter|undefined)=>{const q=filter?.q?.trim();return q?or(ilike(person.fullName,`%${q}%`),ilike(person.primaryEmail,`%${q}%`)):undefined;};
const assignmentEffectiveAt=(eventDate:typeof employment.terminatedOn,_inclusiveEnd:true)=>and(
 eq(assignment.employmentId,employment.id),isNull(assignment.supersededAt),lte(assignment.validFrom,eventDate),
 or(isNull(assignment.validTo),gte(assignment.validTo,eventDate)));
function frozenTerminationRowsTx(tx:Tx,scopeIds:string[]|undefined,p:FrozenPeriodInput) {
  return tx
      .select({
        employmentId: sql<string>`${employment.id}`.as('employment_id'),
        assignmentId: sql<string|null>`${assignment.id}`.as('assignment_id'),
        name: sql<string>`${person.fullName}`.as('name'),
        company: sql<string>`${company.legalName}`.as('company'),
        department: sql<string|null>`${department.name}`.as('department'),
        terminatedOn: sql<string|null>`${employment.terminatedOn}`.mapWith(employment.terminatedOn).as('terminatedOn'),
        terminationType: sql<string|null>`${employment.terminationType}`.as('terminationType'),
        terminationReason: sql<string|null>`${employment.terminationReason}`.as('terminationReason'),
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(assignment, assignmentEffectiveAt(employment.terminatedOn, true))
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .where(
        and(
          gte(employment.terminatedOn, p.from),
          lte(employment.terminatedOn, p.to),
          p.filter?.departmentId ? eq(assignment.departmentId, p.filter.departmentId) : undefined,
          qWhere(p.filter),
          scopeWhere(scopeIds),
        ),
      );
}

async function frozenTerminationsPage(ctx:SessionContext,scopeIds:string[]|undefined,p:FrozenPeriodInput&{page:PageQuery}){
 return database.withTenant(ctx,async tx=>{
  await assertAiPresentationPrincipalTx(tx,ctx);
  const source=frozenTerminationRowsTx(tx,scopeIds,p).as('analytics_terminations_page');
  const rows=await tx.select({name:source.name,company:source.company,department:source.department,terminatedOn:source.terminatedOn,
   terminationType:source.terminationType,terminationReason:source.terminationReason,total:sql<number>`count(*) over()::int`})
   .from(source).orderBy(desc(source.terminatedOn),source.name,source.employmentId,source.assignmentId).limit(p.page.limit).offset(p.page.offset);
  const total=rows.length?Number(rows[0].total):Number((await tx.select({total:sql<number>`count(*)::int`}).from(source))[0]?.total??0);
  return {rows:rows.map(({total,...row})=>row),state:pageState(p.page,total,rows.length)};
 },{readOnlySnapshot:true});
}
function planNodes(value:unknown):Record<string,unknown>[] {
 if(Array.isArray(value))return value.flatMap(planNodes);
 if(!value||typeof value!=='object')return [];
 const node=value as Record<string,unknown>;
 return [...(typeof node['Node Type']==='string'?[node]:[]),...Object.values(node).flatMap(planNodes)];
}
function assertTemporalFence(text:string){
 const lateral=text.match(/left join lateral \(([\s\S]*?)\)\s*as "termination_assignment" on true/i);
 expect(lateral,'Actual compiled SQL must retain its correlated temporal LATERAL source').not.toBeNull();
 if(!lateral)throw Error('Missing compiled temporal LATERAL source');
 expect(lateral[1]).toMatch(/offset 0\s*$/i);
 expect(lateral[1]).not.toMatch(/\blimit\b/i);
 expect(lateral[1]).toContain('"assignment"."employment_id" = "employment"."id"');
 expect(lateral[1]).toContain('"assignment"."valid_to" >= "employment"."terminated_on"');
}

it.skipIf(!requested)('preserves two inclusive adjacent versions, missing/future assignments and complete exports',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional inclusive leaver',primaryEmail:'inclusive-leaver@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const successor=await transferEmployee(ctx,{employmentId:hired.employmentId,departmentId:b.deptB,effectiveDate:'2024-01-01'});
 // Retained/imported shape accepted by the real immediate exclusion constraint:
 // [2020,2024) and [2024,infinity) are adjacent, while the inclusive report matches both.
 await owner.db.update(employment).set({terminatedOn:'2024-01-01',terminationType:'voluntary'}).where(eq(employment.id,hired.employmentId));
 const period={from:'2024-01-01',to:'2024-12-31'},page=parsePageQuery();
 const statements:string[]=[],debug=database.client.options.debug;
 database.client.options.debug=(_connection:number,text:string)=>{statements.push(text);};
 try{
  const actual=await terminationsPage(ctx,[b.companyId],{...period,page});
  expect(actual.state.total).toBe(2);expect(actual.rows.map(row=>row.department).sort()).toEqual(['Finance','Operations']);
  expect(actual).toEqual(await frozenTerminationsPage(ctx,[b.companyId],{...period,page}));
  const exported=await terminations(ctx,[b.companyId],period);
  expect(exported).toHaveLength(2);expect(exported.map(row=>row.department).sort()).toEqual(['Finance','Operations']);
  expect(exported.every(row=>row.terminatedOn==='2024-01-01'&&row.terminationType==='voluntary')).toBe(true);
  expect((await terminationsPage(ctx,[b.companyId],{...period,filter:{departmentId:b.deptA},page})).rows).toEqual(actual.rows.filter(row=>row.department==='Finance'));
  expect((await terminationsPage(ctx,[b.companyId],{...period,filter:{departmentId:b.deptB},page})).rows).toEqual(actual.rows.filter(row=>row.department==='Operations'));
  expect((await terminationsPage(ctx,[b.companyId],{...period,page:parsePageQuery({page:'1'})})).state).toMatchObject({total:2,from:0,to:0});
  const repairedSql=statements.filter(text=>text.includes('termination_assignment'));
  expect(repairedSql.length).toBeGreaterThanOrEqual(5);
  for(const text of repairedSql)assertTemporalFence(text);
  // A correction tombstone still excludes its prior version; the successor remains.
  await owner.db.update(assignment).set({supersededAt:new Date()}).where(and(eq(assignment.employmentId,hired.employmentId),eq(assignment.departmentId,b.deptA)));
  expect((await terminationsPage(ctx,[],{...period,page})).rows.map(row=>row.department)).toEqual(['Operations']);
  await owner.db.update(assignment).set({validFrom:'2025-01-01'}).where(eq(assignment.id,successor.assignmentId));
  expect((await terminationsPage(ctx,[],{...period,page})).rows.map(row=>row.department)).toEqual([null]);
  await owner.db.delete(assignment).where(eq(assignment.employmentId,hired.employmentId));
  expect((await terminationsPage(ctx,[],{...period,page})).rows.map(row=>row.department)).toEqual([null]);
  const foreign=await seedBase();
  expect((await terminationsPage(ctx,[foreign.companyId],{...period,page})).rows).toEqual([]);
 }finally{database.client.options.debug=debug;}
});

it.skipIf(!requested)('compares frozen and repaired termination sources under one native calling-principal app backend',async()=>{
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 expect(poolId).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){
  const target=new URL(process.env[key]!);expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/'+workerDb(poolId!));
 }
 const report:Record<string,unknown>={kind:'DISPOSABLE_NATIVE_TERMINATION_TEMPORAL_JOIN_COMPARISON',releaseEligible:false,employees:50000,
  host:{logicalCpus:cpus().length,cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],ramBytes:totalmem()},
  baselineSourceSha:'01d44d3f32aac2c889abfd9ba676774eabcafc80',
  limits:{maxAppConnections:1,maximumStatementTimeoutMs:20000,maximumLockTimeoutMs:300,testBudgetMs:300000},
  limitations:'Component-only fictional-data diagnostic. EXPLAIN repeats reads in the same snapshot and affects warmth; timings are not an independent production comparison.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'analytics-termination-lateral.json'),JSON.stringify(report,null,2));
 const {b,ctx,foreign}=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
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
 const fluent=new Set(['from','innerJoin','leftJoin','leftJoinLateral','rightJoin','fullJoin','where','groupBy','having','orderBy','limit','offset','$dynamic']);
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
 const page=parsePageQuery(),ended={from:'2024-01-01',to:'2024-12-31'};
 const expectedNames=(start:number)=>Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String((start+i+1)*5).padStart(9,'0'));
 const results=new Map<string,unknown>();
 const verifyPage=(key:string,total:number,names:string[]) => (value:unknown)=>{
  const result=value as Awaited<ReturnType<typeof terminationsPage>>;
  expect(result.state.total).toBe(total);expect(result.rows.map(row=>row.name)).toEqual(names);
  expect(result.rows.every(row=>row.department==='Finance'&&row.terminatedOn==='2024-01-01')).toBe(true);
  const previous=results.get(key);if(previous)expect(result).toEqual(previous);else results.set(key,result);
 };
 try{
  for(const mode of ['original','repaired'] as const){
   const read=mode==='original'?frozenTerminationsPage:terminationsPage;
   await run(mode+'-first',()=>read(ctx,[b.companyId],{...ended,page}),verifyPage('first',10000,expectedNames(0)));
   await run(mode+'-point',()=>read(ctx,[b.companyId],{...ended,filter:{q:'000050000'},page}),verifyPage('point',1,['Fictional retained Personnel 000050000']));
   await run(mode+'-empty',()=>read(ctx,[b.companyId],{...ended,filter:{q:'Fictional definitely absent'},page}),verifyPage('empty',0,[]));
   await run(mode+'-deep',()=>read(ctx,[b.companyId],{...ended,page:parsePageQuery({page:'399'})}),verifyPage('deep',10000,expectedNames(9975)));
   await run(mode+'-company-negative',()=>read(ctx,[foreign.companyId],{...ended,page}),verifyPage('company-negative',0,[]));
  }
 }finally{
  spy.mockRestore();single.client.options.debug=previousDebug;
  report.finalSecurity=await nativeSecurityFingerprint();report.securityUnchanged=digest(report.finalSecurity)===digest(originalSecurity);
  report.appBackendPids=[...pids];report.wireConnectionIds=[...connections];report.phase='complete';report.complete=true;save();
 }
 expect(report.securityUnchanged).toBe(true);expect(pids.size).toBe(1);expect(connections.size).toBe(1);
 const plans=(phaseName:string)=>statements.filter(row=>row.phase===phaseName&&row.analyzed);
 const original=plans('original-first'),repaired=plans('repaired-first');
 expect(original).toHaveLength(1);expect(repaired).toHaveLength(1);
 const originalNodes=planNodes(original[0].analyzed),repairedNodes=planNodes(repaired[0].analyzed);
 const removed=(nodes:Record<string,unknown>[])=>nodes.reduce((sum,node)=>sum+Number(node['Rows Removed by Join Filter']??0)*Number(node['Actual Loops']??1),0);
 report.joinEvidence={originalRemovedJoinRows:removed(originalNodes),repairedRemovedJoinRows:removed(repairedNodes),
  repairedAssignmentIndexProbes:repairedNodes.filter(node=>/Index|Bitmap/.test(String(node['Node Type']))&&String(node['Index Cond']).includes('employment_id'))};
 // The predecessor has also produced a hash join on an independently hosted
 // run. Preserve that measured baseline rather than requiring the planner to
 // reproduce its earlier 500-million-comparison nested loop. The repaired
 // source must still prove the bounded correlated lookup, regardless of which
 // valid baseline plan PostgreSQL chooses from the fixture statistics.
 save();
 expect(originalNodes.length).toBeGreaterThan(0);
 expect(original[0].sql).toContain('left join "assignment"');
 expect(original[0].sql).not.toContain('left join lateral');
 expect(removed(repairedNodes)).toBeLessThan(1000000);
 expect(repairedNodes.some(node=>/Index|Bitmap/.test(String(node['Node Type']))&&String(node['Index Cond']).includes('employment_id')&&Number(node['Actual Loops'])>=10000)).toBe(true);
 for(const statement of statements.filter(row=>row.phase.startsWith('repaired-')&&row.sql.includes('analytics_terminations_page'))){
  assertTemporalFence(statement.sql);
 }
 save();
 expect(outcomes.filter(row=>!row.ok)).toEqual([]);
},300000);
