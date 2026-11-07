/** Original-only hosted query attribution after real3001; no policy/settings experiment. */
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {inArray,sql,SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {assignment,businessUnit} from '../db/schema';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {readEmployeeChoices} from '../core/employee-choice';
import {closeAll,migrateTestDb,owner} from './harness';
import {workerDb} from './db-names';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {capturePostgresEvidence,postgresProfileFromEnv,validatePostgresEvidence} from '../.github/ci/postgres-evidence.mjs';

const file='test/employee-choice-organisation-plan.test.ts';
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
  md5(p.prosrc) as body_md5,p.proowner::regrole::text as owner,p.proacl::text as acl,p.proconfig as settings,p.prosecdef,p.provolatile,p.proparallel
  from pg_proc p where p.oid in ('app.visible_employment_ids()'::regprocedure,'app.visible_person_ids()'::regprocedure,
   'app.can_see_employment(uuid)'::regprocedure,'app.can_see_person(uuid)'::regprocedure) order by p.oid::regprocedure::text`);
 const grants=Array.from(await owner.client`select table_schema,table_name,grantee,privilege_type,is_grantable from information_schema.role_table_grants
  where table_schema='public' and table_name in ('employment','assignment','person','company','department','business_unit') order by table_schema,table_name,grantee,privilege_type`);
 return {policies,functions,grants};
}
let probe:Awaited<ReturnType<typeof prepare>>|undefined;
async function prepare(){
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(poolId).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){
  const target=new URL(process.env[key]!);expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/'+workerDb(poolId!));
 }
 const report:Record<string,unknown>={kind:'ORIGINAL_EMPLOYEE_CHOICE_ORGANISATION_PLAN_ATTRIBUTION',releaseEligible:false,employees:50000,
  variant:'real3001-original-assignment-policy',caseBudgetMs:300000,statementTimeoutMs:20000,lockTimeoutMs:300,targetMs:1000,
  host:{cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],logicalCpus:cpus().length,ramBytes:totalmem()},
  instrumentation:'Native identity/budget checks run in the wrapper; file writes and container telemetry stay outside timed port calls.',
  limitations:'Fictional single-user native component diagnosis only. No policy/function/JIT/work_mem change, migration adoption or capacity claim. Assignment causality requires actual plans.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'employee-choice-organisation-plan.json'),JSON.stringify(report,null,2));
 const fixture=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
 const representedBu=randomUUID(),emptyBu=randomUUID();
 await owner.db.insert(businessUnit).values([
  {id:representedBu,tenantId:fixture.b.tenantId,companyId:fixture.b.companyId,code:'ORG-SUBSET',name:'Fictional organisation subset'},
  {id:emptyBu,tenantId:fixture.b.tenantId,companyId:fixture.b.companyId,code:'ORG-EMPTY',name:'Fictional unrepresented unit'},
 ]);
 await owner.db.update(assignment).set({businessUnitId:representedBu}).where(inArray(assignment.employmentId,fixture.organisationTagSample));
 await owner.client`analyze assignment`;await owner.client`analyze business_unit`;
 const originals=await securitySnapshot(),compact=(text:string)=>text.replace(/\s+/g,'');
 const employmentPolicy=originals.policies.find(row=>row.tablename==='employment'&&row.policyname==='employment_rls');
 expect(compact(employmentPolicy!.qual).split('(idIN(SELECTunnest((SELECTapp.visible_employment_ids()ASvisible_employment_ids))ASunnest))')).toHaveLength(3);
 const assignmentPolicy=originals.policies.find(row=>row.tablename==='assignment'&&row.policyname==='assignment_rls');
 expect(assignmentPolicy).toMatchObject({permissive:'PERMISSIVE',roles:['ai_hr_app'],cmd:'ALL'});
 expect(compact(assignmentPolicy!.qual)).toBe('((tenant_id=app.current_tenant_id())AND(employment_id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[])))');
 expect(compact(assignmentPolicy!.with_check)).toBe('((tenant_id=app.current_tenant_id())ANDapp.can_admin_employment(employment_id))');
 expect(originals.functions.find(row=>row.signature==='app.visible_employment_ids()')?.body_md5).toBe('1bc7e85a740a98b9db79efb2b7768c8b');
 report.originalSecurity=originals;
 const [constraint]=await owner.client`select contype,condeferrable,condeferred,convalidated,pg_get_constraintdef(oid) as definition
  from pg_constraint where conrelid='public.assignment'::regclass and conname='assignment_no_overlap'`;
 expect(constraint).toMatchObject({contype:'x',condeferrable:false,condeferred:false,convalidated:true});report.assignmentCardinalityPrerequisite=constraint;
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','employee_choice_organisation_plan');
 const single=database.createDb(url.toString(),{max:1});expect(single.client.options.max).toBe(1);
 const [session]=await single.client`select pg_backend_pid() as pid,current_setting('jit') as jit,current_setting('work_mem') as work_mem,
  current_setting('hash_mem_multiplier') as hash_mem_multiplier,current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout`;
 const {pid,...defaults}=session;expect(Number.isSafeInteger(pid)&&pid>0).toBe(true);report.sessionDefaults=defaults;
 const pids=new Set<number>([pid]),dialect=new PgDialect(),identities:unknown[]=[],statements:Record<string,unknown>[]=[],plans:Record<string,unknown>[]=[];
 const queries=new Map<string,NativeQuery[]>();report.identities=identities;report.statements=statements;report.plans=plans;
 let name='setup',capture=false,firstSample=false;
 const install=()=>vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>
  single.withTenant(context,async tx=>{
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
       const captured=queries.get(name)??[];captured.push({query:explained,statement,cursorBody,expectedRows:cursorBody?(name==='search'?1:0):result.length});queries.set(name,captured);
      }
      return result;
     }catch(error){entry.errorType=error instanceof Error?error.name:typeof error;throw error;}
     finally{entry.ms=performance.now()-started;}
    };
    const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
   }}));
  },options));
 const unchanged=async()=>{
  expect(await securitySnapshot()).toEqual(originals);
  const [after]=await single.client`select current_setting('jit') as jit,current_setting('work_mem') as work_mem,current_setting('hash_mem_multiplier') as hash_mem_multiplier,
   current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout`;
  expect(after).toEqual(defaults);expect(pids.size).toBe(1);report.originalSecurityAndSettingsUnchanged=true;report.samePhysicalAppBackend=true;save();
 };
 const resources=()=>{
  const profile=postgresProfileFromEnv(process.env),evidence=capturePostgresEvidence('db-1',profile);validatePostgresEvidence(evidence,{postgres:profile});
  const text=execFileSync('docker',['exec',evidence.name,'cat','/sys/fs/cgroup/cpu.stat'],{encoding:'utf8',timeout:10000,maxBuffer:65536});
  return {evidence,cpu:Object.fromEntries(text.trim().split('\n').map(line=>{const [key,value]=line.split(/\s+/);return [key,Number(value)];})),scope:'Owned-container counters/cumulative peak; telemetry runs outside timed port calls.'};
 };
 return {fixture,representedBu,emptyBu,report,save,single,pids,install,queries,dialect,plans,unchanged,resources,
  selectCase:(value:string,first:boolean)=>{name=value;firstSample=first;capture=true;report.phase=value;save();},stop:()=>{capture=false;firstSample=false;},label:(value:string)=>{name=value;}};
}
afterAll(async()=>{try{if(probe)await probe.unchanged();}finally{try{if(probe)await probe.single.client.end({timeout:5});}finally{await closeAll();}}});

it.skipIf(!requested)('measures unchanged native initial/deep/search/organisation/empty ports over50k fictional employees',async()=>{
 probe=await prepare();const p=probe,spy=p.install(),{b,ctx,expectedFirst,expectedLast,organisationTagSample}=p.fixture;
 const active=organisationTagSample.filter((_,index)=>(index+1)%5!==0).slice(0,25),last=expectedLast.at(-1)!;
 const scope={companyIds:[b.companyId],selectedId:last};
 const cases:{name:string;input:Input;total:number;ids:string[];repeat:number;selected:string|null}[]=[
  {name:'initial',input:scope,total:50000,ids:expectedFirst,repeat:2,selected:last},
  {name:'deep',input:{...scope,offset:49975},total:50000,ids:expectedLast,repeat:1,selected:last},
  {name:'search',input:{...scope,query:'PERF000050000'},total:1,ids:[last],repeat:1,selected:last},
  {name:'department-active',input:{...scope,departmentId:b.deptA,status:'active'},total:40000,ids:active,repeat:2,selected:last},
  {name:'department-and-unit',input:{...scope,departmentId:b.deptA,businessUnitId:p.representedBu,status:'active'},total:400,ids:active,repeat:1,selected:last},
  {name:'empty-unit',input:{...scope,departmentId:b.deptA,businessUnitId:p.emptyBu},total:0,ids:[],repeat:1,selected:last},
  {name:'missing-search',input:{...scope,query:'no fictional organisation employee matches'},total:0,ids:[],repeat:1,selected:last},
  {name:'foreign-company',input:{companyIds:[p.fixture.foreign.companyId],selectedId:last},total:0,ids:[],repeat:1,selected:null},
 ];
 const results:Record<string,unknown>={},resources:unknown[]=[];p.report.ports=results;p.report.resourcePhases=resources;
 try{
  for(const c of cases){
   const before=p.resources(),samples:number[]=[];let first:Omit<Page,'contextId'>|undefined;
   for(let repeat=0;repeat<c.repeat;repeat++){
    p.selectCase(c.name,repeat===0);const started=performance.now();let page:Page;
    try{page=await readEmployeeChoices(ctx,c.input);}finally{p.stop();}
    samples.push(performance.now()-started);expect(page.total).toBe(c.total);expect(page.rows.map(row=>row.employmentId)).toEqual(c.ids);expect(page.selected?.employmentId??null).toBe(c.selected);expect(page.rows.length).toBeLessThanOrEqual(25);
    expect(page.companyOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[b.companyId]);
    expect(page.departmentOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[b.deptA]);
    expect(page.allDepartmentOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[b.deptA]);
    expect(page.businessUnitOptions).toEqual(c.name==='foreign-company'?[]:[{id:p.representedBu,name:'Fictional organisation subset'}]);
    if(first)expect(stable(page)).toEqual(first);else first=stable(page);
    results[c.name]={samples,total:page.total,pageRows:page.rows.length,selected:page.selected?.employmentId??null,options:{companies:page.companyOptions,departments:page.departmentOptions,units:page.businessUnitOptions},targetMet:samples.every(ms=>ms<1000)};p.save();
   }
   const after=p.resources();resources.push({case:c.name,before,after,cpuUsageUsec:after.cpu.usage_usec-before.cpu.usage_usec});
  }
  p.report.measurementsComplete=true;await p.unchanged();
 }finally{p.stop();spy.mockRestore();await p.unchanged();}
},300000);

it.skipIf(!requested)('explains the exact unchanged canonical SQL objects with native principal proof and buffers',async()=>{
 expect(probe).toBeTruthy();const p=probe!,spy=p.install();
 try{
  expect([...p.queries.keys()]).toHaveLength(8);
  for(const [name,queries]of p.queries){
   expect(queries.length).toBeGreaterThanOrEqual(4);p.label(name);
   await database.withTenant(p.fixture.ctx,async tx=>{
    await assertAiPresentationPrincipalTx(tx,p.fixture.ctx);
    for(const entry of queries){
     const started=performance.now(),plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${entry.query}`)),wallMs=performance.now()-started;
     const doc=(plan[0] as unknown as {'QUERY PLAN':PlanDocument[]})['QUERY PLAN'][0];expect(doc.Plan['Actual Rows']).toBe(entry.expectedRows);
     p.plans.push({case:name,statement:entry.statement,cursorBody:entry.cursorBody,sql:p.dialect.sqlToQuery(entry.query).sql,wallMs,planningMs:doc['Planning Time'],executionMs:doc['Execution Time'],jit:doc.JIT??null,plan});p.save();
    }
   },{readOnlySnapshot:true});
  }
  await p.unchanged();p.report.phase='complete';p.report.actualPlansComplete=true;p.save();
 }finally{spy.mockRestore();await p.unchanged();}
},300000);
