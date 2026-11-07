/** Hosted frozen c2/unified-boundary comparison after real3001+3102. */
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {inArray,sql,SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi,type TestContext} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {assignment,businessUnit} from '../db/schema';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import * as current from '../core/employee-choice';
import * as baseline from './performance/employee-choice-unified-baseline';
import {createAssignmentAuthorityFixture,assertAssignmentAuthority} from './performance/employee-choice-assignment-authority';
import {closeAll,migrateTestDb,owner} from './harness';
import {workerDb} from './db-names';
import {employeeChoicePlannerSnapshot} from './performance/employee-choice-planner-snapshot';
import {employeeChoiceActualCardinalities,employeeChoiceAuthorizedPopulationFacts,employeeChoicePlanWork} from './performance/employee-choice-plan-work';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {capturePostgresEvidence,postgresProfileFromEnv,validatePostgresEvidence} from '../.github/ci/postgres-evidence.mjs';

const readEmployeeChoices=current.readEmployeeChoices;
const file='test/employee-choice-unified-plan.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);
type Page=Awaited<ReturnType<typeof readEmployeeChoices>>;
type Input=Parameters<typeof readEmployeeChoices>[1];
type NativeQuery={query:SQL;statement:number;cursorBody:boolean;expectedRows:number};
type PlanDocument={Plan:Record<string,unknown>;'Planning Time':number;'Execution Time':number;JIT?:unknown};
const stable=({contextId:_contextId,...page}:Page)=>page;
async function securitySnapshot(){
 const policies=Array.from(await owner.client`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
  from pg_policies where schemaname in ('public','app') order by schemaname,tablename,policyname`);
 const functions=Array.from(await owner.client`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,
  md5(p.prosrc) as body_md5,p.proowner::regrole::text as owner,p.proacl::text as acl,p.proconfig as settings,p.prosecdef,p.provolatile,p.proparallel,
  p.prorettype::regtype::text as return_type,p.proretset,p.pronargs,p.proisstrict,p.proleakproof,p.prokind,p.procost,p.prorows,(select lanname from pg_language where oid=p.prolang) as language
  from pg_proc p where p.oid in ('app.visible_employment_ids()'::regprocedure,'app.visible_person_ids()'::regprocedure,
   'app.can_see_employment(uuid)'::regprocedure,'app.can_see_person(uuid)'::regprocedure) order by p.oid::regprocedure::text`);
 const grants=Array.from(await owner.client`select table_schema,table_name,grantee,privilege_type,is_grantable from information_schema.role_table_grants
  where table_schema='public' and table_name in ('employment','assignment','person','company','department','business_unit') order by table_schema,table_name,grantee,privilege_type`);
 const indexes=Array.from(await owner.client`select n.nspname as schema_name,t.relname as table_name,c.relname as index_name,
  pg_get_indexdef(i.indexrelid) as definition,pg_get_expr(i.indpred,i.indrelid) as predicate,i.indisvalid,i.indisready,i.indimmediate
  from pg_index i join pg_class c on c.oid=i.indexrelid join pg_class t on t.oid=i.indrelid join pg_namespace n on n.oid=t.relnamespace
  where t.oid='public.assignment'::regclass order by c.relname`);
 return {policies,functions,grants,indexes};
}
type Variant='original'|'unified';
const variants=['original','unified']as const;
let probe:Awaited<ReturnType<typeof prepare>>|undefined;
let preparingSingle:ReturnType<typeof database.createDb>|undefined;
let activeWork:Promise<void>|undefined;
let activeSignal:AbortSignal|undefined;
let blocked:Error|undefined;
// Vitest aborts a timed-out test without waiting for its async body. Drain that
// body (including its policy/fixture finally) before permitting any later work.
async function boundedCase(context:TestContext,work:()=>Promise<void>,setup=false){
 if(blocked)throw blocked;
 expect(activeWork).toBeUndefined();activeSignal=context.signal;
 let closing:Promise<unknown>|undefined;
 const abort=()=>{
  blocked=new Error('Diagnostic case aborted; later cases may not touch this database',{cause:context.signal.reason});
  closing=Promise.allSettled([preparingSingle?.client.end({timeout:0}),...(setup?[closeAll()]:[])]);
 };
 context.signal.addEventListener('abort',abort,{once:true});
 const pending=Promise.resolve().then(work);activeWork=pending;
 context.onTestFinished(async()=>{
  try{await closing;await pending;}
  finally{context.signal.removeEventListener('abort',abort);activeWork=undefined;activeSignal=undefined;}
 });
 try{await pending;}
 catch(error){
  if(setup){
   blocked=error instanceof Error?error:new Error('Diagnostic preparation failed');
   await Promise.allSettled([preparingSingle?.client.end({timeout:0}),closeAll()]);
  }
  throw error;
 }
}
const assertCaseActive=()=>activeSignal?.throwIfAborted();
async function prepare(){
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 expect(createHash('sha256').update(readFileSync('test/performance/employee-choice-unified-baseline.ts')).digest('hex')).toBe('9e830d169630dca113b96e34f9c05ebd3da13ef3ed2d391c91304e4397e4bffd');
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(poolId).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){
  const target=new URL(process.env[key]!);expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/'+workerDb(poolId!));
 }
 const report:Record<string,unknown>={kind:'CONTROLLED_EMPLOYEE_CHOICE_UNIFIED_NATIVE_BOUNDARY',releaseEligible:false,employees:50000,
  variants:[...variants],nativeMigrations:'real3001+3102 unchanged',caseBudgetMs:300000,statementTimeoutMs:20000,lockTimeoutMs:300,targetMs:1000,
  host:{cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],logicalCpus:cpus().length,ramBytes:totalmem()},
  instrumentation:'Native identity/budget checks run in the wrapper; file writes and container telemetry stay outside timed port calls.',
  limitations:'Same native3001+3102 authority and single application backend. Compare exact frozen c2f5c019 facet reader to a single authorized native identity/Assignment boundary. No index DDL. Read-only planner statistics are captured outside timed calls. No policy/function/grant/JIT/work_mem changes; no production index or latency/capacity acceptance claim.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'employee-choice-unified-plan.json'),JSON.stringify(report,null,2));
 const fixture=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
 const representedBu=randomUUID(),emptyBu=randomUUID();
 await owner.db.insert(businessUnit).values([
  {id:representedBu,tenantId:fixture.b.tenantId,companyId:fixture.b.companyId,code:'ORG-SUBSET',name:'Fictional organisation subset'},
  {id:emptyBu,tenantId:fixture.b.tenantId,companyId:fixture.b.companyId,code:'ORG-EMPTY',name:'Fictional unrepresented unit'},
 ]);
 await owner.db.update(assignment).set({businessUnitId:representedBu}).where(inArray(assignment.employmentId,fixture.organisationTagSample));
 await owner.client`analyze assignment`;await owner.client`analyze business_unit`;
 const wholeFixture=await employeeChoiceActualCardinalities(owner.db);report.exactWholeFixtureCardinalities=wholeFixture;save();
 const originals=await securitySnapshot(),compact=(text:string)=>text.replace(/\s+/g,'');
 const employmentPolicy=originals.policies.find(row=>row.tablename==='employment'&&row.policyname==='employment_rls');
 expect(compact(employmentPolicy!.qual).split('(idIN(SELECTunnest((SELECTapp.visible_employment_ids()ASvisible_employment_ids))ASunnest))')).toHaveLength(3);
 const assignmentPolicy=originals.policies.find(row=>row.tablename==='assignment'&&row.policyname==='assignment_rls');
 expect(assignmentPolicy).toMatchObject({permissive:'PERMISSIVE',roles:['ai_hr_app'],cmd:'ALL'});
 expect(compact(assignmentPolicy!.qual)).toBe('((tenant_id=app.current_tenant_id())AND(employment_idIN(SELECTunnest((SELECTapp.visible_employment_ids()ASvisible_employment_ids))ASunnest)))');
 expect(compact(assignmentPolicy!.with_check)).toBe('((tenant_id=app.current_tenant_id())ANDapp.can_admin_employment(employment_id))');
 expect(originals.functions.find(row=>row.signature==='app.visible_employment_ids()')).toMatchObject({body_md5:'1bc7e85a740a98b9db79efb2b7768c8b',owner:'postgres',acl:'{=X/postgres,postgres=X/postgres,ai_hr_app=X/postgres,ai_hr_reward_setup_reader=X/postgres}',settings:['search_path=public'],prosecdef:true,provolatile:'s',proparallel:'u',return_type:'uuid[]',proretset:false,pronargs:0,proisstrict:false,proleakproof:false,prokind:'f',procost:100,prorows:0,language:'plpgsql'});
 expect(originals.indexes.some(row=>String(row.index_name).startsWith('employee_choice_probe_'))).toBe(false);
 report.originalSecurity=originals;
 const [constraint]=await owner.client`select contype,condeferrable,condeferred,convalidated,pg_get_constraintdef(oid) as definition
  from pg_constraint where conrelid='public.assignment'::regclass and conname='assignment_no_overlap'`;
 expect(constraint).toMatchObject({contype:'x',condeferrable:false,condeferred:false,convalidated:true});report.assignmentCardinalityPrerequisite=constraint;
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','employee_choice_assignment_comparison');
 assertCaseActive();const single=database.createDb(url.toString(),{max:1});preparingSingle=single;
 try{
 expect(single.client.options.max).toBe(1);
 const [session]=await single.client`select pg_backend_pid() as pid,current_setting('jit') as jit,current_setting('work_mem') as work_mem,
  current_setting('hash_mem_multiplier') as hash_mem_multiplier,current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout`;
 const {pid,...defaults}=session;expect(Number.isSafeInteger(pid)&&pid>0).toBe(true);report.sessionDefaults=defaults;
 const pids=new Set<number>([pid]),dialect=new PgDialect(),identities:unknown[]=[],statements:Record<string,unknown>[]=[],plans:Record<string,unknown>[]=[];
 const queries=new Map<string,NativeQuery[]>();report.identities=identities;report.statements=statements;report.plans=plans;
 let name='setup',capture=false,firstSample=false,activeCursor:NativeQuery|undefined;
 const install=()=>vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>
  {assertCaseActive();return single.withTenant(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
   const [identity]=await tx.execute<{role:string;pid:number;tenant:string;user:string;read_only:string;isolation:string;employment_rls:boolean;person_rls:boolean;assignment_rls:boolean;jit:string;work_mem:string;hash_mem_multiplier:string;statement_timeout:string;lock_timeout:string}>(sql`
    select current_user as role,pg_backend_pid() as pid,app.current_tenant_id() as tenant,app.current_user_id() as "user",
     current_setting('transaction_read_only') as read_only,current_setting('transaction_isolation') as isolation,
     row_security_active('public.employment'::regclass) as employment_rls,row_security_active('public.person'::regclass) as person_rls,row_security_active('public.assignment'::regclass) as assignment_rls,
     current_setting('jit') as jit,current_setting('work_mem') as work_mem,current_setting('hash_mem_multiplier') as hash_mem_multiplier,
     current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout`);
   expect(identity).toMatchObject({role:'ai_hr_app',tenant:context.tenantId,user:context.userId,read_only:'on',isolation:'repeatable read',employment_rls:true,person_rls:true,assignment_rls:true,
    jit:defaults.jit,work_mem:defaults.work_mem,hash_mem_multiplier:defaults.hash_mem_multiplier,statement_timeout:'20s',lock_timeout:'300ms'});
   pids.add(identity.pid);identities.push({case:name,...identity});
   return read(new Proxy(tx,{get(target,key,receiver){
    if(key==='execute'&&capture)return async(query:SQL)=>{
     const text=dialect.sqlToQuery(query).sql,statement=statements.length,entry:Record<string,unknown>={case:name,statement,sql:text},started=performance.now();statements.push(entry);
     let explained=query,cursorBody=false;
     if(/^\s*declare /i.test(text)){
      // Capture the original nested SELECT SQL object from the canonical DECLARE,
      // retaining every native join/predicate and parameter; do not reconstruct SQL.
      const nested=query.queryChunks.filter((chunk):chunk is SQL=>chunk instanceof SQL);expect(nested).toHaveLength(1);
      explained=nested[0];expect(text.endsWith(dialect.sqlToQuery(explained).sql)).toBe(true);cursorBody=true;
     }
     try{
      const result=await target.execute(query);
      if(firstSample&&(cursorBody||/^\s*(select |with )/i.test(text))&&!text.includes('select exists(select 1 from public.app_user u')){
       const captured=queries.get(name)??[],entry:NativeQuery={query:explained,statement,cursorBody,expectedRows:cursorBody?0:result.length};captured.push(entry);queries.set(name,captured);if(cursorBody)activeCursor=entry;
      }
      if(firstSample&&/^\s*fetch forward /i.test(text)&&activeCursor)activeCursor.expectedRows+=result.length;
      if(/^\s*close /i.test(text))activeCursor=undefined;
      return result;
     }catch(error){entry.errorType=error instanceof Error?error.name:typeof error;throw error;}
     finally{entry.ms=performance.now()-started;}
    };
    const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
   }}));
  },options);});
 const unchanged=async()=>{
  expect(await securitySnapshot()).toEqual(originals);
  const [after]=await single.client`select current_setting('jit') as jit,current_setting('work_mem') as work_mem,current_setting('hash_mem_multiplier') as hash_mem_multiplier,
   current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout`;
  expect(after).toEqual(defaults);expect(pids.size).toBe(1);report.originalSecurityAndSettingsUnchanged=true;report.samePhysicalAppBackend=true;save();
 };
 // No index experiment or schema change: compare only the native read boundary.
 const capturedStatistics=new Set<Variant>();
 const choose=async(variant:Variant)=>{assertCaseActive();await unchanged();if(!capturedStatistics.has(variant)){
  const snapshots=(report.plannerStatistics??={})as Record<string,unknown>;snapshots[variant]=await employeeChoicePlannerSnapshot();capturedStatistics.add(variant);
 }report.phase=variant;save();};
 const restore=async()=>{await unchanged();report.originalIndexesRestored=true;save();};
 const resources=()=>{
  const profile=postgresProfileFromEnv(process.env),evidence=capturePostgresEvidence('db-1',profile);validatePostgresEvidence(evidence,{postgres:profile});
  const text=execFileSync('docker',['exec',evidence.name,'cat','/sys/fs/cgroup/cpu.stat'],{encoding:'utf8',timeout:10000,maxBuffer:65536});
  return {evidence,cpu:Object.fromEntries(text.trim().split('\n').map(line=>{const [key,value]=line.split(/\s+/);return [key,Number(value)];})),scope:'Owned-container counters/cumulative peak; telemetry runs outside timed port calls.'};
 };
 const populationFacts=async(key:string,companyIds:readonly string[])=>{
  assertCaseActive();capture=false;firstSample=false;name=key+':population-facts';
  const facts=await database.withTenant(fixture.ctx,async tx=>{await assertAiPresentationPrincipalTx(tx,fixture.ctx);
   return employeeChoiceAuthorizedPopulationFacts(tx,fixture.ctx.tenantId,companyIds);},{readOnlySnapshot:true});
  const factsByCase=(report.authorizedServerPopulationFacts??={})as Record<string,unknown>;factsByCase[key]=facts;save();return facts;
 };
 return {fixture,representedBu,emptyBu,wholeFixture,populationFacts,report,save,single,pids,install,queries,dialect,plans,unchanged,resources,choose,restore,
  selectCase:(value:string,first:boolean)=>{assertCaseActive();name=value;firstSample=first;capture=true;report.phase=value;save();},stop:()=>{capture=false;firstSample=false;},label:(value:string)=>{name=value;}};
 }catch(error){await single.client.end({timeout:0});throw error;}
}
afterAll(async()=>{
 // Never race the last case's finally, even if its test timer already rejected.
 if(activeWork)await activeWork.catch(()=>{});
 try{if(probe){
  await probe.restore();
  const report=probe.report;
  report.complete=variants.every(variant=>['performanceVariants','planVariants'].every(field=>(report[field]as string[]|undefined)?.includes(variant)))&&report.authorityComplete===true;
  const measured=Object.entries((report.ports??{})as Record<string,{samples?:number[];ms?:number}>).filter(([key])=>key.startsWith('unified:'));
  report.candidateWholePortTarget={targetMs:1000,measuredPorts:measured.length,allUnderTarget:report.complete===true
   ?measured.length===14&&measured.every(([,port])=>port.samples?.length?port.samples.every(ms=>ms<1000):typeof port.ms==='number'&&port.ms<1000):null};
  report.phase=report.complete?'complete':'incomplete';probe.save();
 }}
 finally{try{if(preparingSingle)await preparingSingle.client.end({timeout:5});}finally{await closeAll();}}
});

it.skipIf(!requested)('prepares the retained 50k fictional fixture independently of measurement',context=>boundedCase(context,async()=>{
 const started=performance.now();probe=await prepare();
 probe.report.preparation={complete:true,ms:performance.now()-started,caseBudgetMs:300000};probe.save();
},true),300000);

const baselinePages=new Map<string,Omit<Page,'contextId'>>();
it.skipIf(!requested).for(variants)('measures every whole native organisation port with %s query shape',{timeout:300000},(variant,context)=>boundedCase(context,async()=>{
 expect(probe).toBeTruthy();const p=probe!,spy=p.install(),{b,ctx,expectedFirst,expectedLast,organisationTagSample}=p.fixture;
 const active=organisationTagSample.filter((_,index)=>(index+1)%5!==0).slice(0,25),last=expectedLast.at(-1)!;
 const scope={companyIds:[b.companyId],selectedId:last};
 const cases:{name:string;input:Input;total:number;ids:string[];repeat:number;selected:string|null}[]=[
  {name:'initial',input:scope,total:50000,ids:expectedFirst,repeat:2,selected:last},
  {name:'deep',input:{...scope,offset:49975},total:50000,ids:expectedLast,repeat:1,selected:last},
  {name:'search',input:{...scope,query:'PERF000050000'},total:1,ids:[last],repeat:1,selected:last},
  {name:'department-active',input:{...scope,departmentId:b.deptA,status:'active'},total:40000,ids:active,repeat:2,selected:last},
  {name:'department-and-unit',input:{...scope,departmentId:b.deptA,businessUnitId:p.representedBu,status:'active'},total:400,ids:active,repeat:1,selected:last},
  {name:'unit-active',input:{...scope,businessUnitId:p.representedBu,status:'active'},total:400,ids:active,repeat:1,selected:last},
  {name:'organisation-deep',input:{...scope,departmentId:b.deptA,businessUnitId:p.representedBu,status:'active',offset:375},total:400,ids:organisationTagSample.filter((_,index)=>(index+1)%5!==0).slice(375),repeat:1,selected:last},
  {name:'organisation-search',input:{...scope,departmentId:b.deptA,businessUnitId:p.representedBu,query:'PERF000000001'},total:1,ids:[organisationTagSample[0]],repeat:1,selected:last},
  {name:'empty-unit',input:{...scope,departmentId:b.deptA,businessUnitId:p.emptyBu},total:0,ids:[],repeat:1,selected:last},
  {name:'missing-search',input:{...scope,query:'no fictional organisation employee matches'},total:0,ids:[],repeat:1,selected:last},
  {name:'foreign-company',input:{companyIds:[p.fixture.foreign.companyId],selectedId:last},total:0,ids:[],repeat:1,selected:null},
 ];
 const results=(p.report.ports??={})as Record<string,unknown>,resourcePhases=(p.report.resourcePhases??=[])as unknown[];
 try{
  await p.choose(variant);
  for(const c of cases){
   const key=variant+':'+c.name;await p.populationFacts(key,c.input.companyIds);
   const before=p.resources(),samples:number[]=[];let first:Omit<Page,'contextId'>|undefined;
   for(let repeat=0;repeat<c.repeat;repeat++){
    p.selectCase(key,repeat===0);const started=performance.now();let page:Page;
    try{page=await (variant==='original'?baseline.readEmployeeChoices:readEmployeeChoices)(ctx,c.input);}finally{p.stop();}
    samples.push(performance.now()-started);expect(page.total).toBe(c.total);expect(page.rows.map(row=>row.employmentId)).toEqual(c.ids);expect(page.selected?.employmentId??null).toBe(c.selected);expect(page.rows.length).toBeLessThanOrEqual(25);
    expect(page.companyOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[b.companyId]);
    expect(page.departmentOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[b.deptA]);expect(page.allDepartmentOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[b.deptA]);
    expect(page.businessUnitOptions).toEqual(c.name==='foreign-company'?[]:[{id:p.representedBu,name:'Fictional organisation subset'}]);
    if(first)expect(stable(page)).toEqual(first);else first=stable(page);
    if(variant==='original')baselinePages.set(c.name,stable(page));else expect(stable(page)).toEqual(baselinePages.get(c.name));
    results[key]={samples,total:page.total,pageRows:page.rows.length,selected:page.selected?.employmentId??null,options:{companies:page.companyOptions,departments:page.departmentOptions,units:page.businessUnitOptions},targetMet:samples.every(ms=>ms<1000)};p.save();
   }
   const after=p.resources();resourcePhases.push({variant,case:c.name,before,after,cpuUsageUsec:after.cpu.usage_usec-before.cpu.usage_usec});
  }
  const idsKey=variant+':complete-ids';await p.populationFacts(idsKey,[b.companyId]);p.selectCase(idsKey,true);
  try{
   const started=performance.now(),reader=variant==='original'?baseline.readEmployeeChoiceIdsTx:current.readEmployeeChoiceIdsTx;
   const ids=await database.withTenant(ctx,tx=>reader(tx,ctx,{companyIds:[b.companyId],departmentId:b.deptA,businessUnitId:p.representedBu,status:'active'}),{readOnlySnapshot:true});
   expect(ids).toEqual(organisationTagSample.filter((_,index)=>(index+1)%5!==0));
   for(const entry of p.queries.get(idsKey)??[])if(entry.cursorBody)entry.expectedRows=400;
   results[idsKey]={ms:performance.now()-started,total:ids.length,completeIds:true};p.save();
  }finally{p.stop();}
  for(const barrier of ['access','history']as const){
   await p.populationFacts(variant+':held-'+barrier,[b.companyId]);
   let release!:()=>void,entered!:()=>void,writerPid=0;
   const ready=new Promise<void>(resolve=>{entered=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});
   const writer=owner.client.begin(async tx=>{
    if(barrier==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
    else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId}))`;
    const [identity]=await tx`select pg_backend_pid() as pid`;writerPid=identity.pid;entered();await done;
   });
   try{
    await Promise.race([ready,writer.then(()=>{throw Error('Writer ended before the controlled read');})]);
    p.label(variant+':held-'+barrier);const started=performance.now();
    const page=await (variant==='original'?baseline.readEmployeeChoices:readEmployeeChoices)(ctx,{...scope,departmentId:b.deptA,businessUnitId:p.representedBu,status:'active'});
    expect(page.total).toBe(400);expect(page.rows.map(row=>row.employmentId)).toEqual(active);expect(page.selected?.employmentId).toBe(last);
    expect(stable(page)).toEqual(baselinePages.get('department-and-unit'));
    const [held]=await owner.client`select exists(select 1 from pg_locks where locktype='advisory' and granted and pid=${writerPid}) as held`;
    expect(held.held).toBe(true);results[variant+':held-'+barrier]={ms:performance.now()-started,total:page.total,completedBeforeWriterRelease:true,writerPid};p.save();
   }finally{release();await writer;}
  }
  const completed=(p.report.performanceVariants??=[])as string[];completed.push(variant);p.save();
 }finally{p.stop();spy.mockRestore();await p.restore();}
}));

it.skipIf(!requested).for(variants)('captures actual %s identity/page plans without changing native authority or SQL budgets',{timeout:300000},(variant,context)=>boundedCase(context,async()=>{
 expect(probe).toBeTruthy();const p=probe!,spy=p.install();
 try{
  expect([...p.queries.keys()]).toHaveLength(variants.length*12);
  for(const [key,queries]of p.queries){
   if(!key.startsWith(variant+':'))continue;await p.choose(variant);p.label(key);expect(queries.length).toBeGreaterThanOrEqual(variant==='unified'||key.endsWith(':complete-ids')?1:4);
   await database.withTenant(p.fixture.ctx,async tx=>{
    await assertAiPresentationPrincipalTx(tx,p.fixture.ctx);
    for(const entry of queries){
     assertCaseActive();const started=performance.now(),plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${entry.query}`)),wallMs=performance.now()-started;
     const evidence:Record<string,unknown>={variant,case:key,statement:entry.statement,cursorBody:entry.cursorBody,
      sql:p.dialect.sqlToQuery(entry.query).sql,wallMs,expectedRows:entry.expectedRows,plan};p.plans.push(evidence);p.save();
     // Persist the full native EXPLAIN before parsing or enforcing any actual counter.
     const doc=(plan[0] as unknown as {'QUERY PLAN':PlanDocument[]})['QUERY PLAN'][0];
     const assignmentNodes:unknown[]=[],windowNodes:unknown[]=[];
     const visit=(node:Record<string,unknown>)=>{
      const facts=Object.fromEntries(['Node Type','Relation Name','Index Name','Actual Rows','Actual Loops','Actual Total Time','Shared Hit Blocks','Shared Read Blocks','Temp Read Blocks','Temp Written Blocks'].filter(field=>field in node).map(field=>[field,node[field]]));
      if(node['Relation Name']==='assignment')assignmentNodes.push(facts);if(node['Node Type']==='WindowAgg')windowNodes.push(facts);
      for(const child of (node.Plans??[])as Record<string,unknown>[])visit(child);
     };visit(doc.Plan);
     Object.assign(evidence,{planningMs:doc['Planning Time'],executionMs:doc['Execution Time'],jit:doc.JIT??null,assignmentNodes,windowNodes});p.save();
     if(variant==='unified'&&p.dialect.sqlToQuery(entry.query).sql.includes('employee_choice_employments as materialized')){
      const work=employeeChoicePlanWork(doc.Plan,p.wholeFixture);evidence.work=work;p.save();
      expect(work.rejectionReasons).toEqual([]);
     }
     expect(doc.Plan['Actual Rows']).toBe(entry.expectedRows);
    }
   },{readOnlySnapshot:true});
  }
  const completed=(p.report.planVariants??=[])as string[];completed.push(variant);
  p.report.actualPlansComplete=variants.every(name=>completed.includes(name));p.report.queryShapeUnchanged=false;p.report.nativeAuthorityUnchanged=true;p.save();
 }finally{spy.mockRestore();await p.restore();}
}));

let authorityFixture:Awaited<ReturnType<typeof createAssignmentAuthorityFixture>>|undefined;
let originalAuthority:Awaited<ReturnType<typeof assertAssignmentAuthority>>|undefined;
it.skipIf(!requested).for(variants)('preserves all native ordinary/scoped/history/refusal controls with %s query shape',{timeout:300000},(variant,context)=>boundedCase(context,async()=>{
 expect(probe).toBeTruthy();const p=probe!;authorityFixture??=await createAssignmentAuthorityFixture();const spy=p.install();
 try{
  await p.choose(variant);p.label(variant+':authority');
  const port=vi.spyOn(current,'readEmployeeChoices').mockImplementation(variant==='original'?baseline.readEmployeeChoices:readEmployeeChoices);
  let result:Awaited<ReturnType<typeof assertAssignmentAuthority>>;
  try{result=await assertAssignmentAuthority(authorityFixture);}finally{port.mockRestore();}
  if(variant==='original')originalAuthority=result;else expect(result).toEqual(originalAuthority);
  const results=(p.report.authority??={})as Record<string,unknown>;results[variant]=result;
  p.report.authorityComplete=variants.every(name=>Object.hasOwn(results,name));p.save();
 }finally{spy.mockRestore();await p.restore();}
}));
