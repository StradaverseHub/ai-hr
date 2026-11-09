import {admitSingletonTest} from './helpers/ci-singleton-admission';
/** Hosted Assignment-only representation experiment after real3001; disposable DB only. */
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {inArray,sql,SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi,type TestContext} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {assignment,businessUnit} from '../db/schema';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {readEmployeeChoices} from '../core/employee-choice';
import {createAssignmentAuthorityFixture,assertAssignmentAuthority} from './performance/employee-choice-assignment-authority';
import {closeAll,migrateTestDb,owner} from './harness';
import {workerDb} from './db-names';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {capturePostgresEvidence,postgresProfileFromEnv,validatePostgresEvidence} from '../.github/ci/postgres-evidence.mjs';

const file='test/employee-choice-assignment-membership-plan.test.ts';
const singletonAdmission=admitSingletonTest(file);
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
type Variant='original'|'wrapped';
const variants=['original','wrapped']as const;
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
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(singletonAdmission.evidenceDirectory).toBeTruthy();
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(poolId).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){
  const target=new URL(process.env[key]!);expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/'+workerDb(poolId!));
 }
 const report:Record<string,unknown>={kind:'CONTROLLED_ASSIGNMENT_MEMBERSHIP_REPRESENTATION',releaseEligible:false,employees:50000,
  variants:['original','wrapped'],employmentMigration:'real3001 unchanged',caseBudgetMs:300000,statementTimeoutMs:20000,lockTimeoutMs:300,targetMs:1000,
  host:{cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],logicalCpus:cpus().length,ramBytes:totalmem()},
  instrumentation:'Native identity/budget checks run in the wrapper; file writes and container telemetry stay outside timed port calls.',
  limitations:'Only the reviewed positive Assignment membership representation changes in this disposable DB. No function/index/JIT/work_mem change, migration adoption or capacity claim. Query shape is unchanged; broad per-employment/window work is reported separately from membership gains.'};
 const save=()=>writeFileSync(join(singletonAdmission.evidenceDirectory!,'employee-choice-assignment-membership-plan.json'),JSON.stringify(report,null,2));
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
 expect(originals.functions.find(row=>row.signature==='app.visible_employment_ids()')).toMatchObject({body_md5:'1bc7e85a740a98b9db79efb2b7768c8b',owner:'postgres',acl:'{=X/postgres,postgres=X/postgres,ai_hr_app=X/postgres,ai_hr_reward_setup_reader=X/postgres}',settings:['search_path=public'],prosecdef:true,provolatile:'s',proparallel:'u',return_type:'uuid[]',proretset:false,pronargs:0,proisstrict:false,proleakproof:false,prokind:'f',procost:100,prorows:0,language:'plpgsql'});
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
 let name='setup',capture=false,firstSample=false;
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
       const captured=queries.get(name)??[];captured.push({query:explained,statement,cursorBody,expectedRows:cursorBody?(name.endsWith(':search')?1:0):result.length});queries.set(name,captured);
      }
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
 const oldMembership='(employment_id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[]))';
 const wrappedMembership='(employment_idIN(SELECTunnest((SELECTapp.visible_employment_ids()ASvisible_employment_ids))ASunnest))';
 const pattern=/\(employment_id\s*=\s*ANY\s*\(\(\s*SELECT\s+app\.visible_employment_ids\(\)\s+AS\s+visible_employment_ids\s*\)::uuid\[\]\)\)/g;
 expect(assignmentPolicy!.qual.match(pattern)).toHaveLength(1);
 const candidate=assignmentPolicy!.qual.replace(pattern,'(employment_id IN (SELECT unnest((SELECT app.visible_employment_ids()))))');
 const reviewed=async()=>{
  const current=await securitySnapshot(),target=current.policies.find(row=>row.tablename==='assignment'&&row.policyname==='assignment_rls');
  const expression=compact(target!.qual);
  expect([compact(assignmentPolicy!.qual),compact(assignmentPolicy!.qual).replace(oldMembership,wrappedMembership)]).toContain(expression);
  expect({...current,policies:current.policies.map(row=>row===target?{...row,qual:assignmentPolicy!.qual}:row)}).toEqual(originals);
 };
 const choose=async(variant:Variant)=>{
  assertCaseActive();await reviewed();
  await owner.client.begin(async tx=>{await tx`set local lock_timeout='300ms'`;await tx`set local statement_timeout='20s'`;
   await tx.unsafe('ALTER POLICY assignment_rls ON public.assignment USING ('+(variant==='original'?assignmentPolicy!.qual:candidate)+')');});
  await reviewed();const current=await securitySnapshot(),target=current.policies.find(row=>row.tablename==='assignment'&&row.policyname==='assignment_rls');
  expect(compact(target!.qual)).toBe(variant==='original'?compact(assignmentPolicy!.qual):compact(assignmentPolicy!.qual).replace(oldMembership,wrappedMembership));
  report.phase=variant;save();
 };
 const restore=async()=>{
  await owner.client.begin(async tx=>{await tx`set local lock_timeout='300ms'`;await tx`set local statement_timeout='20s'`;
   await tx.unsafe('ALTER POLICY assignment_rls ON public.assignment USING ('+assignmentPolicy!.qual+')');});
  await unchanged();report.originalAssignmentPolicyRestored=true;save();
 };
 const resources=()=>{
  const profile=postgresProfileFromEnv(process.env),evidence=capturePostgresEvidence(singletonAdmission.databaseUnit,profile);validatePostgresEvidence(evidence,{postgres:profile});
  const text=execFileSync('docker',['exec',evidence.name,'cat','/sys/fs/cgroup/cpu.stat'],{encoding:'utf8',timeout:10000,maxBuffer:65536});
  return {evidence,cpu:Object.fromEntries(text.trim().split('\n').map(line=>{const [key,value]=line.split(/\s+/);return [key,Number(value)];})),scope:'Owned-container counters/cumulative peak; telemetry runs outside timed port calls.'};
 };
 return {fixture,representedBu,emptyBu,report,save,single,pids,install,queries,dialect,plans,unchanged,resources,choose,restore,
  selectCase:(value:string,first:boolean)=>{assertCaseActive();name=value;firstSample=first;capture=true;report.phase=value;save();},stop:()=>{capture=false;firstSample=false;},label:(value:string)=>{name=value;}};
 }catch(error){await single.client.end({timeout:0});throw error;}
}
afterAll(async()=>{
 // Never race the last case's finally, even if its test timer already rejected.
 if(activeWork)await activeWork.catch(()=>{});
 try{if(probe)await probe.restore();}
 finally{try{if(preparingSingle)await preparingSingle.client.end({timeout:5});}finally{await closeAll();}}
});

it('prepares the retained 50k fictional fixture independently of measurement',context=>boundedCase(context,async()=>{
 const started=performance.now();probe=await prepare();
 probe.report.preparation={complete:true,ms:performance.now()-started,caseBudgetMs:300000};probe.save();
},true),300000);

const baselinePages=new Map<string,Omit<Page,'contextId'>>();
it.for(variants)('measures every whole native organisation port with %s Assignment membership',{timeout:300000},(variant,context)=>boundedCase(context,async()=>{
 expect(probe).toBeTruthy();const p=probe!,spy=p.install(),{b,ctx,expectedFirst,expectedLast,organisationTagSample}=p.fixture;
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
 const results=(p.report.ports??={})as Record<string,unknown>,resourcePhases=(p.report.resourcePhases??=[])as unknown[];
 try{
  await p.choose(variant);
  const a='00000000-0000-0000-0000-000000000001',z='00000000-0000-0000-0000-000000000002';
  const truth=await owner.client`with inputs(id,subject,members,tenant_allowed) as(values
   (1,${a}::uuid,null::uuid[],true),(2,${a}::uuid,array[]::uuid[],true),(3,null::uuid,array[${a}::uuid],true),
   (4,${a}::uuid,array[null::uuid],true),(5,${a}::uuid,array[${a}::uuid,${a}::uuid],true),
   (6,${a}::uuid,array[null::uuid,${a}::uuid],true),(7,${a}::uuid,array[${a}::uuid],false),
   (8,${z}::uuid,array[${a}::uuid],true),(9,${z}::uuid,array[null::uuid,${a}::uuid],true))
   select id,(tenant_allowed and subject=any(members))is true as original,
    (tenant_allowed and subject in(select unnest((select members))))is true as wrapped from inputs order by id`;
  expect(truth.map(row=>row.original)).toEqual([false,false,false,false,true,true,false,false,false]);expect(truth.map(row=>row.wrapped)).toEqual(truth.map(row=>row.original));p.report.positiveTruthTable=truth;
  for(const c of cases){
   const key=variant+':'+c.name,before=p.resources(),samples:number[]=[];let first:Omit<Page,'contextId'>|undefined;
   for(let repeat=0;repeat<c.repeat;repeat++){
    p.selectCase(key,repeat===0);const started=performance.now();let page:Page;
    try{page=await readEmployeeChoices(ctx,c.input);}finally{p.stop();}
    samples.push(performance.now()-started);expect(page.total).toBe(c.total);expect(page.rows.map(row=>row.employmentId)).toEqual(c.ids);expect(page.selected?.employmentId??null).toBe(c.selected);expect(page.rows.length).toBeLessThanOrEqual(25);
    expect(page.companyOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[b.companyId]);
    expect(page.departmentOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[b.deptA]);expect(page.allDepartmentOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[b.deptA]);
    expect(page.businessUnitOptions).toEqual(c.name==='foreign-company'?[]:[{id:p.representedBu,name:'Fictional organisation subset'}]);
    if(first)expect(stable(page)).toEqual(first);else first=stable(page);
    if(variant==='original')baselinePages.set(c.name,stable(page));else expect(stable(page)).toEqual(baselinePages.get(c.name));
    results[key]={samples,total:page.total,pageRows:page.rows.length,selected:page.selected?.employmentId??null,options:{companies:page.companyOptions,departments:page.departmentOptions,units:page.businessUnitOptions},targetMet:samples.every(ms=>ms<1000)};p.save();
   }
   const after=p.resources();resourcePhases.push({variant,case:c.name,before,after,cpuUsageUsec:after.cpu.usage_usec-before.cpu.usage_usec});
   if(variant==='wrapped')expect(p.queries.get(key)!.map(item=>p.dialect.sqlToQuery(item.query).sql)).toEqual(p.queries.get('original:'+c.name)!.map(item=>p.dialect.sqlToQuery(item.query).sql));
  }
  const completed=(p.report.performanceVariants??=[])as string[];completed.push(variant);p.save();
 }finally{p.stop();spy.mockRestore();await p.restore();}
}));

it.for(variants)('captures actual %s plans and remaining loops/window work without changing query shape',{timeout:300000},(variant,context)=>boundedCase(context,async()=>{
 expect(probe).toBeTruthy();const p=probe!,spy=p.install();
 try{
  expect([...p.queries.keys()]).toHaveLength(16);
  for(const [key,queries]of p.queries){
   if(!key.startsWith(variant+':'))continue;await p.choose(variant);p.label(key);expect(queries.length).toBeGreaterThanOrEqual(4);
   await database.withTenant(p.fixture.ctx,async tx=>{
    await assertAiPresentationPrincipalTx(tx,p.fixture.ctx);
    for(const entry of queries){
     assertCaseActive();const started=performance.now(),plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${entry.query}`)),wallMs=performance.now()-started;
     const doc=(plan[0] as unknown as {'QUERY PLAN':PlanDocument[]})['QUERY PLAN'][0];expect(doc.Plan['Actual Rows']).toBe(entry.expectedRows);
     const assignmentNodes:unknown[]=[],windowNodes:unknown[]=[];
     const visit=(node:Record<string,unknown>)=>{
      const facts=Object.fromEntries(['Node Type','Relation Name','Index Name','Actual Rows','Actual Loops','Actual Total Time','Shared Hit Blocks','Shared Read Blocks','Temp Read Blocks','Temp Written Blocks'].filter(field=>field in node).map(field=>[field,node[field]]));
      if(node['Relation Name']==='assignment')assignmentNodes.push(facts);if(node['Node Type']==='WindowAgg')windowNodes.push(facts);
      for(const child of (node.Plans??[])as Record<string,unknown>[])visit(child);
     };visit(doc.Plan);
     p.plans.push({variant,case:key,statement:entry.statement,cursorBody:entry.cursorBody,sql:p.dialect.sqlToQuery(entry.query).sql,wallMs,planningMs:doc['Planning Time'],executionMs:doc['Execution Time'],jit:doc.JIT??null,assignmentNodes,windowNodes,plan});p.save();
    }
   },{readOnlySnapshot:true});
  }
  const completed=(p.report.planVariants??=[])as string[];completed.push(variant);
  p.report.actualPlansComplete=variants.every(name=>completed.includes(name));p.report.queryShapeUnchanged=true;p.save();
 }finally{spy.mockRestore();await p.restore();}
}));

let authorityFixture:Awaited<ReturnType<typeof createAssignmentAuthorityFixture>>|undefined;
let originalAuthority:Awaited<ReturnType<typeof assertAssignmentAuthority>>|undefined;
it.for(variants)('preserves all native ordinary/scoped/history/refusal controls with %s Assignment membership',{timeout:300000},(variant,context)=>boundedCase(context,async()=>{
 expect(probe).toBeTruthy();const p=probe!;authorityFixture??=await createAssignmentAuthorityFixture();const spy=p.install();
 try{
  await p.choose(variant);p.label(variant+':authority');const result=await assertAssignmentAuthority(authorityFixture);
  if(variant==='original')originalAuthority=result;else expect(result).toEqual(originalAuthority);
  const results=(p.report.authority??={})as Record<string,unknown>;results[variant]=result;
  p.report.authorityComplete=variants.every(name=>Object.hasOwn(results,name));if(p.report.authorityComplete)p.report.phase='complete';p.save();
 }finally{spy.mockRestore();await p.restore();}
}));
