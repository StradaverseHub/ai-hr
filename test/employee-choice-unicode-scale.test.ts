/** Exact ECMAScript search must remain complete when every name is non-ASCII. */
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {availableParallelism,cpus,totalmem} from 'node:os';
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi,type TestContext} from 'vitest';
import {readEmployeeChoices,readEmployeeChoicesTx} from '../core/employee-choice';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {assignment,company,department,employment,person} from '../db/schema';
import {isEmployeeChoicePage,type EmployeeChoicePage} from '../lib/employee-choice';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {applicationDatabaseBudget} from '../db/capacity';
import {closeAll,migrateTestDb,owner,type Base} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
// This additional course is selected only by the existing focused controller. Other
// Vitest runs keep the original setup and measurement, with their original URLs.
const facetAdmission=await vi.hoisted(async()=>{
 const file='test/employee-choice-unicode-scale.test.ts';
 if(process.env.AIHR_FOCUSED_TESTS!==JSON.stringify([file]))return undefined;
 const sha=/^[0-9a-f]{40}$/;
 if(process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||
    process.env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'||process.platform!=='linux'||process.env.TEST_DB_NAMESPACE!=='aifocus'||
    process.env.WORKER_DB==='0'||!/^\d+$/.test(process.env.GITHUB_RUN_ID??'')||!/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT??'')||
    !sha.test(process.env.AIHR_CI_HEAD??'')||!sha.test(process.env.AIHR_CI_CONTROL_HEAD??'')||!process.env.AIHR_FOCUSED_EVIDENCE_DIR)
  throw new Error('Dedicated employee facet probe requires the ordinary hosted focused controller');
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 if(!poolId||!/^([12])$/.test(poolId))throw new Error('Dedicated employee facet worker identity is missing');
 const {workerDb}=await import('./db-names'),database=workerDb(poolId);
 const keys=['DATABASE_URL','TEST_MIGRATION_DATABASE_URL'] as const;
 const previous=keys.map(key=>process.env[key]);
 const urls=previous.map((value,index)=>{
  if(!value)throw new Error('Dedicated employee facet worker URL is missing');
  const url=new URL(value),role=index===0?'ai_hr_app':'postgres';
  if(url.protocol!=='postgres:'||url.hostname!=='127.0.0.1'||url.port!=='5433'||url.username!==role||
     url.password||url.pathname!=='/'+database||url.search||url.hash||
     (index===0&&value!==process.env.TEST_DATABASE_URL)||(index===1&&value!==process.env.MIGRATION_DATABASE_URL))
   throw new Error('Dedicated employee facet worker URL differs');
  url.searchParams.set('connect_timeout',index===0?'1':'2');
  // This closed fixture uses scalar/JSON codecs and server-cast array text.
  // Avoid the driver's detached discovery query on these two pools only.
  url.searchParams.set('fetch_types','false');
  url.searchParams.set('statement_timeout',index===0?'500ms':'10s');
  if(index===0)url.searchParams.set('lock_timeout','300ms');
  return url.toString();
 });
 for(const [index,key] of keys.entries())process.env[key]=urls[index];
 return {database,source:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD,restore(){
  for(const [index,key] of keys.entries()){
   const value=previous[index];if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 }};
});
facetAdmission?.restore();
let ownedWork:Promise<void>|undefined;
let allowPoolClose=true;
beforeAll(migrateTestDb);
afterAll(async()=>{
 await ownedWork?.catch(()=>{});
 if(!allowPoolClose)throw new Error('Unconfirmed native facet settlement requires the owned-job stop');
 await closeAll();
});
it('measures exact full and missing searches over the real 50k Unicode population',(context:TestContext)=>{
 const caseStart=performance.now();
 const pending=Promise.resolve().then(async()=>{
 if(facetAdmission)verifyFacetPools(facetAdmission.database);
 const originalAbort=new AbortController(),originalSignal=AbortSignal.any([context.signal,originalAbort.signal]);
 const active=()=>{if(facetAdmission)originalSignal.throwIfAborted();};
 active();
 const report:Record<string,unknown>={kind:'NATIVE_UNICODE_EMPLOYEE_CHOICE_COMPONENT_ONLY',releaseEligible:false,employees:50000,namePrefix:'Fictional retained Personnel 人員 ',host:{node:process.version,logicalCpus:availableParallelism(),memoryBytes:totalmem(),cpuModels:[...new Set(cpus().map(cpu=>cpu.model))]}};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-choice-unicode-50k.json'),JSON.stringify(report,null,2));};
 const {b,ctx,expectedFirst,expectedLast,organisationTagSample}=await seedPersonnelNativeFixture(50000,report,name=>{active();report.phase=name;save();},()=>{active();save();},'Fictional retained Personnel 人員 ');
 report.fixtureReady=true;save();
 const statements:Record<string,unknown>[]=[],timings:Record<string,number>={};report.statements=statements;report.timings=timings;
 const actual=database.withTenant,dialect=new PgDialect();
 const captured:SQL[]=[],originalCallbacks=new Set<Promise<unknown>>();
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(session:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(session,tx=>{
  const callback=(async()=>{
  active();await tx.execute(sql`set local lock_timeout='300ms'`);active();await tx.execute(sql`set local statement_timeout='20s'`);
  return read(new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(query:SQL)=>{
    active();const entry:Record<string,unknown>={sql:dialect.sqlToQuery(query).sql},started=performance.now();statements.push(entry);save();
    if(facetAdmission&&isDepartmentFacet(String(entry.sql)))captured.push(query);
    try{return await target.execute(query);}catch(error){entry.error=String(error);throw error;}finally{entry.ms=performance.now()-started;save();}
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }}));
  })();
  if(facetAdmission){
   originalCallbacks.add(callback);
   void callback.then(()=>originalCallbacks.delete(callback),()=>originalCallbacks.delete(callback));
  }
  return callback;
 },facetAdmission?{...options,readSignal:originalSignal}:options));
 try{
  let started=performance.now();const first=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'人員',selectedId:expectedLast.at(-1)});timings.firstMs=performance.now()-started;
  expect(isEmployeeChoicePage(JSON.parse(JSON.stringify(first)))).toBe(true);expect(first.total).toBe(50000);expect(first.rows.map(row=>row.employmentId)).toEqual(expectedFirst);expect(first.selected?.employmentId).toBe(expectedLast.at(-1));expect(first.rows.every(row=>row.name.includes('人員'))).toBe(true);
  started=performance.now();const deep=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'人員',offset:49975});timings.deepMs=performance.now()-started;
  expect(deep.total).toBe(50000);expect(deep.rows.map(row=>row.employmentId)).toEqual(expectedLast);
  started=performance.now();const missing=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'absent-unicode-choice',selectedId:expectedLast.at(-1)});timings.missingMs=performance.now()-started;
  expect(missing.total).toBe(0);expect(missing.rows).toEqual([]);expect(missing.selected?.employmentId).toBe(expectedLast.at(-1));
  started=performance.now();const filtered=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'人員',departmentId:b.deptA,status:'active',selectedId:expectedLast.at(-1)});timings.organisationFilteredMs=performance.now()-started;
  expect(isEmployeeChoicePage(JSON.parse(JSON.stringify(filtered)))).toBe(true);expect(filtered.total).toBe(40000);expect(filtered.rows.map(row=>row.employmentId)).toEqual(organisationTagSample.filter((_,index)=>(index+1)%5!==0).slice(0,25));expect(filtered.selected?.employmentId).toBe(expectedLast.at(-1));
  report.maxPageRows=Math.max(first.rows.length,deep.rows.length,missing.rows.length,filtered.rows.length);report.exactNativeIdsAndCounts=true;save();
 }catch(error){originalAbort.abort(error);throw error;}finally{
  spy.mockRestore();await Promise.allSettled([...originalCallbacks]);save();
 }
 if(facetAdmission){
  expect(statements).toHaveLength(305);
  expect(captured).toHaveLength(4);
  await probeDepartmentFacet({b,ctx,expectedFirst,captured,dialect,report,save,actual,caseStart,signal:context.signal},facetAdmission);
 }
 });
 ownedWork=pending;
 context.onTestFinished(async()=>{await pending.catch(()=>{});ownedWork=undefined;});
 return pending;
},300000);

const legacyHash='95900f68e826391eea261670dbeff344a7ef75e2ba921090ceef1ed949de172e';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const isDepartmentFacet=(text:string)=>text.startsWith('select "company"."id" as "companyId",')&&text.includes('cross join "department"');
const uuidArray=(ids:readonly string[])=>'{'+ids.join(',')+'}';

function verifyFacetPools(expectedDatabase:string){
 for(const [pool,role,connect,statement]of [[database.client,'ai_hr_app',1,'500ms'],[owner.client,'postgres',2,'10s']] as const){
  expect(pool.options).toMatchObject({host:['127.0.0.1'],port:[5433],database:expectedDatabase,user:role,connect_timeout:connect,fetch_types:false});
  expect(Object.hasOwn(pool.options.connection,'fetch_types')).toBe(false);
  expect(pool.options.connection.statement_timeout).toBe(statement);
 }
 expect(database.client.options.connection.lock_timeout).toBe('300ms');
 expect(database.client.options.max).toBe(applicationDatabaseBudget(process.env).poolMax);
 expect(owner.client.options.max).toBe(10);
 expect(database.client).not.toBe(owner.client);
}

/** The frozen names-mode statement from the retained two-department fixture. */
function legacyDepartmentFacet(tenantId:string,companyId:string){
 const scope=sql`${employment.tenantId}=${tenantId}::uuid and ${employment.companyId}=any(${uuidArray([companyId])}::uuid[])`;
 const assignedMembers=sql`from ${assignment} join ${employment} on ${employment.id}=${assignment.employmentId}
  join ${person} on ${person.id}=${employment.personId} and ${person.tenantId}=${tenantId}::uuid
  where ${scope} and ${employment.companyId}=${company.id} and ${assignment.tenantId}=${tenantId}::uuid
   and ${assignment.validTo} is null and ${assignment.supersededAt} is null`;
 return sql`select ${company.id} as "companyId",${company.legalName} as company,${department.id} as "departmentId",null::text as "departmentCode",
  ${department.name} as department,
  null::uuid as "businessUnitId",null::text as "businessUnitCode",null::text as "businessUnit"
 from ${company} cross join ${department}
 where ${company.tenantId}=${tenantId}::uuid and ${department.tenantId}=${tenantId}::uuid
  and exists(select 1 ${assignedMembers} and ${assignment.departmentId}=${department.id} offset 0) order by "companyId","departmentId"`;
}

function stressPage(b:Base,ids:readonly string[],total:number):Omit<EmployeeChoicePage,'contextId'>{
 const finance={id:b.deptA,name:'Finance'};
 return {rows:ids.map((employmentId,index)=>{
  const ordinal=index+1,number=String(ordinal).padStart(9,'0');
  return {employmentId,name:'Fictional retained Personnel 人員 '+number,employeeCode:'PERF'+number,
   company:'Acme Sdn Bhd',companyId:b.companyId,department:'Finance',departmentId:b.deptA,departmentCode:null,
   businessUnit:null,businessUnitId:null,businessUnitCode:null,status:ordinal%5===0?'ended':'active'};
 }),selected:null,total,offset:0,limit:25,labelMode:'names',filters:{query:'',companyId:'',departmentId:'',businessUnitId:'',status:''},
 companyOptions:[{id:b.companyId,name:'Acme Sdn Bhd'}],departmentOptions:[finance],allDepartmentOptions:[finance],businessUnitOptions:[]};
}

const realmColumns=sql`current_database() as database,d.oid::text as "databaseOid",inet_server_addr()::text as address,
 inet_server_port() as port,current_setting('server_version_num') as version,current_user as role,session_user as login,
 pg_backend_pid() as pid,(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart",
 current_setting('statement_timeout') as "statementTimeout",current_setting('lock_timeout') as "lockTimeout"`;
type Realm={database:string;databaseOid:string;address:string;port:number;version:string;role:string;login:string;pid:number;backendStart:string;statementTimeout:string;lockTimeout:string};
type AppFacts=Realm&{tenant:string;actor:string;isolation:string;readOnly:boolean;superuser:boolean;bypass:boolean;rls:Record<string,boolean>;planner:Record<string,string>;catalogue:unknown};
const appFacts=sql`select ${realmColumns},app.current_tenant_id()::text as tenant,app.current_user_id()::text as actor,
 current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only')='on' as "readOnly",r.rolsuper as superuser,r.rolbypassrls as bypass,
 (select jsonb_object_agg(c.relname,row_security_active(c.oid)) from pg_class c where c.oid in
 ('public.assignment'::regclass,'public.employment'::regclass,'public.person'::regclass,'public.company'::regclass,'public.department'::regclass)) as rls,
 (select jsonb_object_agg(name,setting) from pg_settings where category like 'Query Tuning%' or name in
 ('work_mem','hash_mem_multiplier','search_path','row_security','jit','plan_cache_mode','max_parallel_workers_per_gather')) as planner,
 jsonb_build_object('collation',jsonb_build_array(d.datcollate,d.datctype,d.daticulocale,d.datcollversion),
  'tables',(select jsonb_agg(jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.oid)
    from pg_class c where c.oid in ('public.assignment'::regclass,'public.employment'::regclass,'public.person'::regclass,'public.company'::regclass,'public.department'::regclass)),
  'policies',(select jsonb_agg(jsonb_build_array(p.polrelid::text,p.polname,p.polcmd,p.polpermissive,p.polroles::text,
    pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polrelid,p.polname) from pg_policy p where p.polrelid in
    ('public.assignment'::regclass,'public.employment'::regclass,'public.person'::regclass,'public.company'::regclass,'public.department'::regclass)),
  'indexes',(select jsonb_agg(jsonb_build_array(i.indexrelid::text,i.indisvalid,i.indisready,i.indislive,pg_get_indexdef(i.indexrelid)) order by i.indexrelid)
    from pg_index i where i.indrelid='public.assignment'::regclass),
  'statistics',(select jsonb_build_array(c.reltuples,c.relpages,c.relallvisible,s.last_analyze::text,s.last_autoanalyze::text)
    from pg_class c join pg_stat_all_tables s on s.relid=c.oid where c.oid='public.assignment'::regclass)) as catalogue
 from pg_database d join pg_roles r on r.rolname=current_user where d.datname=current_database()`;

const realm=(identity:Realm)=>[identity.database,identity.databaseOid,identity.address,identity.port,identity.version];
const assertBackend=(identity:Realm)=>{
 expect(identity.pid).toBeGreaterThan(0);expect(Number.isSafeInteger(identity.pid)).toBe(true);
 expect(identity.backendStart).toMatch(/^\d+(?:\.\d+)?$/);
};

type PlanNode={ [key:string]:unknown; Plans?:PlanNode[] };
function summarizePlan(raw:unknown,assignmentFirst:boolean,maxAssignmentLoops:number){
 if(!Array.isArray(raw)||raw.length!==1||!raw[0]||typeof raw[0]!=='object')throw new Error('Unexpected native facet plan envelope');
 const document=raw[0] as Record<string,unknown>;
 const measure=(value:unknown)=>{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('Invalid native facet plan counter');
  return value;
 };
 const assignments:{node:string;loops:number;sharedHits:number;qual:string[]}[]=[];
 let nodes=0,witnesses=0;
 function walk(node:PlanNode,depth:number,insideAssignment=false){
  if(!node||typeof node!=='object'||Array.isArray(node)||++nodes>2048||depth>64||typeof node['Node Type']!=='string')
   throw new Error('Unexpected native facet plan node');
  const isAssignment=node['Relation Name']==='assignment';
  if(isAssignment){
   const qual=['Filter','Index Cond','Recheck Cond'].map(key=>node[key]).filter((value):value is string=>typeof value==='string');
   assignments.push({node:node['Node Type'],loops:measure(node['Actual Loops']),sharedHits:measure(node['Shared Hit Blocks']),qual});
  }
  if(insideAssignment&&node['Relation Name']==='employment'&&measure(node['Actual Loops'])>0){
   const predicates=['Filter','Index Cond','Recheck Cond'].map(key=>node[key]).filter((value):value is string=>typeof value==='string');
   if(predicates.some(value=>value.includes('assignment.employment_id')))witnesses++;
  }
  if(node.Plans!==undefined&&!Array.isArray(node.Plans))throw new Error('Unexpected native facet plan children');
  for(const child of node.Plans??[])walk(child,depth+1,insideAssignment||isAssignment);
 }
 walk(document.Plan as PlanNode,0);
 if(assignmentFirst){
  expect(assignments).toHaveLength(1);
  const [source]=assignments;
  expect(source.loops).toBeGreaterThan(0);expect(source.loops).toBeLessThanOrEqual(maxAssignmentLoops);
  expect(source.qual.some(value=>value.includes('assignment.department_id')&&value.includes('department.id'))).toBe(true);
  expect(witnesses).toBeGreaterThan(0);
 }
 return {planningMs:measure(document['Planning Time']),executionMs:measure(document['Execution Time']),nodes,
  jitReported:Object.hasOwn(document,'JIT'),assignmentNodes:assignments.map(({qual:_qual,...value})=>value),correlatedWitnesses:witnesses};
}

type Probe={b:Base;ctx:SessionContext;expectedFirst:string[];captured:SQL[];dialect:PgDialect;report:Record<string,unknown>;
 save:()=>void;actual:typeof database.withTenant;caseStart:number;signal:AbortSignal};

async function probeDepartmentFacet(p:Probe,admission:NonNullable<typeof facetAdmission>){
 const {b,ctx,dialect,report,save,signal}=p;
 const probeStart=performance.now(),matchedEnd=probeStart+27000,batchEnd=matchedEnd+5000,stressEnd=batchEnd+18000,end=stressEnd+10000;
 if(p.caseStart+300000-probeStart<65000)throw new Error('Insufficient original case lifetime for the closed facet probe');
 expect(ctx.entitlements?.tenantStatus).toBe('active');
 expect(ctx.entitlements?.settings?.['audit.hash_chain_enabled']).not.toBe(true);
 expect(process.env.AUDIT_HASH_CHAIN_ENABLED).toBeUndefined();
 const state={source:admission.source,controller:admission.controller,complete:false,settled:false,unconfirmed:false,
  slotMilliseconds:[27000,5000,18000,10000],phase:'matched',plans:[] as Record<string,unknown>[],ordinaryMs:{} as Record<string,number>,
  matchedImprovement:{ordinary:false,instrumented:false},
  stress:[] as {label:string;wallMs:number;departmentMs:number;explainMs?:number;total:number;statements:number;rows:number}[]};
 report.facetCandidate=state;
 const rawPlans:{label:string;raw:unknown}[]=[],metadata:Record<string,unknown>={startup:{
  app:{poolMax:database.client.options.max,connectMs:1000,fetchTypes:database.client.options.fetch_types,nativeBootstrapMs:1500},
  owner:{poolMax:owner.client.options.max,connectMs:2000,fetchTypes:owner.client.options.fetch_types,authenticatedWarmupMs:10000,authenticatedSetupMs:10000},
  preparedStatements:database.client.options.prepare,
  stressStatementCount:'PRODUCT_EXECUTE_POSITIONS_EXCLUDING_DRIVER_PROTOCOL_AND_RETRY',
 }};
 const persist=()=>{
  const detail=JSON.stringify(metadata);
  if(Buffer.byteLength(detail)>65536)throw new Error('Private facet metadata exceeds 64KiB');
  const plans=JSON.stringify(rawPlans);
  if(Buffer.byteLength(plans)>4*1024*1024)throw new Error('Private facet plans exceed 4MiB');
  const path=join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'employee-choice-department-existence-private.json');
  writeFileSync(path,JSON.stringify({kind:'FICTIONAL_NATIVE_DEPARTMENT_EXISTENCE_CANDIDATE',metadata,rawPlans}),{mode:0o600});
  save();
 };
 const fit=(deadline:number,ms:number,operation:string,cleanup=false)=>{
  if(!cleanup)signal.throwIfAborted();
  if(performance.now()+ms>deadline)throw new Error('Native facet slot refused before '+operation);
 };
 const tenant=b.tenantId,companyArray=uuidArray([b.companyId]);
 const previous=legacyDepartmentFacet(tenant,b.companyId),candidate=p.captured[0];
 const old=dialect.sqlToQuery(previous),compiled=dialect.sqlToQuery(candidate);
 expect(Buffer.byteLength(old.sql)).toBe(934);expect(digest(old.sql)).toBe(legacyHash);
 expect(old.params).toEqual([tenant,tenant,tenant,tenant,companyArray,tenant]);
 expect(compiled.params).toEqual([tenant,tenant,tenant,tenant,tenant,companyArray]);
 expect(isDepartmentFacet(compiled.sql)).toBe(true);
 expect(p.captured.map(query=>dialect.sqlToQuery(query))).toEqual(p.captured.map(()=>compiled));
 metadata.sql={legacy:legacyHash,candidate:digest(compiled.sql),parameterCount:6};
 const proofRows=[{companyId:b.companyId,company:'Acme Sdn Bhd',departmentId:b.deptA,departmentCode:null,department:'Finance',
  businessUnitId:null,businessUnitCode:null,businessUnit:null}];
 const identities:AppFacts[]=[];
 let appStarts=0;
 const fixture:{reservation?:Awaited<ReturnType<typeof owner.client.reserve>>;realm?:Realm;transaction:boolean;tightened:boolean}={transaction:false,tightened:false};
 const startOwner=async()=>{
  // postgres.js 3.4.9 does not hand off a cold reserve with fetch_types off.
  // A normal query reaches ReadyForQuery, which opens the socket before the
  // waiting promise continues. This sole-file course has no other owner work.
  fit(matchedEnd,22000,'owner cold connect, authenticated warmup and setup');
  const [warm]=await owner.client<{pid:number;backendStart:string}[]>`select pg_backend_pid() as pid,
   extract(epoch from backend_start)::text as "backendStart" from pg_stat_activity
   where pid=pg_backend_pid() and datname=${admission.database} and current_database()=${admission.database}
     and current_user='postgres' and session_user='postgres' and inet_server_port()=5433
     and inet_server_addr()='127.0.0.1'::inet and current_setting('statement_timeout')='10s'`;
  if(!warm||!Number.isSafeInteger(warm.pid)||warm.pid<=0||!/^\d+(?:\.\d+)?$/.test(warm.backendStart))
   throw new Error('Authenticated owner warmup refused');
  fit(matchedEnd,10000,'owner immediate reservation and authenticated setup');
  // Call reserve in this same continuation without any intervening await.
  const reservation=await owner.client.reserve();fixture.reservation=reservation;
  metadata.ownerWarmup=warm;
  fit(matchedEnd,10000,'reserved owner realm and limits');
  const [identity]=await reservation<(Realm&{boundStatement:string;boundLock:string})[]>`with live as materialized (
    select current_database() as database,d.oid::text as "databaseOid",inet_server_addr()::text as address,
     inet_server_port() as port,current_setting('server_version_num') as version,current_user as role,session_user as login,
     pg_backend_pid() as pid,(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart",
     current_setting('statement_timeout') as "statementTimeout",current_setting('lock_timeout') as "lockTimeout"
    from pg_database d where d.datname=current_database() and d.datname=${admission.database}
      and current_user='postgres' and session_user='postgres' and inet_server_port()=5433
      and inet_server_addr()='127.0.0.1'::inet and current_setting('statement_timeout')='10s'
      and pg_backend_pid()=${warm.pid} and exists(select 1 from pg_stat_activity a where a.pid=${warm.pid}
        and extract(epoch from a.backend_start)::text=${warm.backendStart})
   ), tightened as materialized (
    select set_config('statement_timeout','1s',false) as "boundStatement",set_config('lock_timeout','300ms',false) as "boundLock" from live
   ) select live.*,tightened.* from live cross join tightened`;
  if(!identity)throw new Error('Reserved owner realm refused');
  fixture.tightened=true;fixture.realm=identity;metadata.owner=identity;
  expect(identity).toMatchObject({database:admission.database,role:'postgres',login:'postgres',statementTimeout:'10s',boundStatement:'1s',boundLock:'300ms'});
  assertBackend(identity);
 };
 const recordIdentity=(identity:AppFacts,ms:string)=>{
  if(!identity)throw new Error('Native application realm is missing');
  assertBackend(identity);identities.push(identity);metadata.app=identities;
  expect(identity).toMatchObject({database:admission.database,role:'ai_hr_app',login:'ai_hr_app',tenant,actor:ctx.userId,
   isolation:'repeatable read',readOnly:true,superuser:false,bypass:false,statementTimeout:ms,lockTimeout:'300ms',port:5433,
   rls:{assignment:true,employment:true,person:true,company:true,department:true}});
 };
 const snapshot=async(deadline:number,finalMs:number,work:(tx:Tx,assertPhase:()=>void)=>Promise<void>)=>{
  // Cold app startup budgets 1s to connect and 3×500ms for BEGIN, mode
  // and context. The four-second frontier also charges queue and wire time.
  fit(deadline,4000+finalMs,'application admission and bootstrap');
  const frontier=new AbortController(),bootstrapEnd=performance.now()+4000;
  const timer=setTimeout(()=>frontier.abort(new Error('Facet application bootstrap deadline elapsed')),4000);
  const readSignal=AbortSignal.any([signal,frontier.signal]);
  const pending:{callback?:Promise<void>}={};
  appStarts++;
  try{
   await p.actual(ctx,tx=>{
    readSignal.throwIfAborted();fit(bootstrapEnd,0,'application callback entry');clearTimeout(timer);
    pending.callback=Promise.resolve().then(()=>work(tx,()=>readSignal.throwIfAborted()));
    return pending.callback;
   },{readOnlySnapshot:true,readSignal});
   fit(deadline,0,'settled application transaction');
  }catch(error){frontier.abort(error);throw error;}finally{
   clearTimeout(timer);
   // postgres.js begin can reject on connection close before its callback ends.
   await pending.callback?.catch(()=>{});
  }
 };
 const explain=async(tx:Tx,query:SQL,label:string,first:boolean,loops:number)=>{
  const started=performance.now();
  const rows=await tx.execute<{ 'QUERY PLAN':unknown }>(sql`explain(analyze,buffers,verbose,settings,timing off,format json) ${query}`);
  const wallMs=performance.now()-started;
  expect(rows).toHaveLength(1);
  const raw=rows[0]['QUERY PLAN'];
  const bytes=Buffer.byteLength(JSON.stringify(raw));
  if(rawPlans.length>=4||bytes>1024*1024)throw new Error('Native facet plan inventory or size refused');
  rawPlans.push({label,raw});persist();
  const summary=summarizePlan(raw,first,loops);
  state.plans.push({label,wallMs,...summary});persist();
  return summary;
 };
 const appWithLimit=(tx:Tx,limit:'3s'|'1s')=>tx.execute<AppFacts&{bound:string}>(sql`with live as materialized (${appFacts}),
  bounded as materialized (select set_config('statement_timeout',${limit},true) as bound from live)
  select live.*,bounded.bound from live cross join bounded`);

 let workError:unknown;
 try{
  persist();
  const ownerWork=Promise.resolve().then(startOwner);
  const matchWork=snapshot(matchedEnd,3000,async(tx,assertPhase)=>{
   const step=(ms:number,operation:string)=>{assertPhase();fit(matchedEnd,ms+3000,operation);};
   step(500,'matched principal');await assertAiPresentationPrincipalTx(tx,ctx);
   step(500,'matched reset statistics snapshot');await tx.execute(sql`select pg_stat_clear_snapshot()`);
   step(500,'matched application metadata');const [start]=await appWithLimit(tx,'3s');recordIdentity(start,'500ms');expect(start.bound).toBe('3s');
   for(const [label,query]of [['old',previous],['candidate',candidate]] as const){
    step(3000,label+' ordinary statement');const started=performance.now();const rows=await tx.execute(query);
    state.ordinaryMs[label]=performance.now()-started;expect(Array.from(rows)).toEqual(proofRows);persist();
   }
   step(3000,'old matched plan');const oldPlan=await explain(tx,previous,'old-matched',false,2);
   step(3000,'candidate matched plan');const candidatePlan=await explain(tx,candidate,'candidate-matched',true,2);
   step(3000,'matched final statistics reset');await tx.execute(sql`select pg_stat_clear_snapshot()`);
   step(3000,'matched final native metadata');const [after]=await tx.execute<AppFacts>(appFacts);
   const {bound:_bound,...startFacts}=start;
   expect(after).toEqual({...startFacts,statementTimeout:'3s'});metadata.matchedFinal=after;
   state.matchedImprovement={ordinary:state.ordinaryMs.candidate<state.ordinaryMs.old,instrumented:candidatePlan.executionMs<oldPlan.executionMs};
   fit(matchedEnd,3000,'matched transaction finalization');
  });
  const matched=await Promise.allSettled([ownerWork,matchWork]);
  const refused=matched.filter(result=>result.status==='rejected');
  if(refused.length)throw new AggregateError(refused.map(value=>value.reason),'Matched application or owner phase refused');
  const {reservation,realm:ownerRealm}=fixture;
  if(!reservation||!ownerRealm)throw new Error('No owned fixture socket');
  expect(realm(identities[0])).toEqual(realm(ownerRealm));
  expect(identities[0].pid).not.toBe(ownerRealm.pid);

  state.phase='catalogue-batch';const batchDeadline=Math.min(batchEnd,performance.now()+5000);
  persist();fit(batchDeadline,4000,'fixed eight-department transaction');
  const empty=Array.from({length:8},(_,index)=>({id:randomUUID(),name:'Facet probe empty department '+String(index+1).padStart(2,'0')}));
  await reservation`begin`;fixture.transaction=true;
  fit(batchDeadline,3000,'fixed eight-department insert');
  const inserted=await reservation<{id:string;name:string}[]>`insert into public.department(id,tenant_id,company_id,name)
   select x.id,${tenant}::uuid,${b.companyId}::uuid,x.name from jsonb_to_recordset(${JSON.stringify(empty)}::jsonb) x(id uuid,name text)
   returning id::text,name`;
  const byName=(left:{name:string},right:{name:string})=>left.name.localeCompare(right.name);
  expect(Array.from(inserted).sort(byName)).toEqual(empty);
  fit(batchDeadline,2000,'fixed eight-department commit');await reservation`commit`;fixture.transaction=false;
  fit(batchDeadline,1000,'fixed catalogue, Criteria and zero Assignment references');
  const [batch]=await reservation`select current_database() as database,pg_backend_pid() as pid,
   (select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart",
   (select jsonb_agg(jsonb_build_object('id',d.id,'name',d.name) order by d.name) from public.department d
    where d.id=any(${uuidArray(empty.map(row=>row.id))}::uuid[]) and d.tenant_id=${tenant}::uuid and d.company_id=${b.companyId}::uuid) as rows,
   (select count(*)::int from public.department where tenant_id=${tenant}::uuid) as departments,
   (select count(*)::int from public.label_company_assignment l where l.tenant_id=${tenant}::uuid and l.label_kind='department'
    and l.label_id=any(${uuidArray(empty.map(row=>row.id))}::uuid[]) and l.company_id=${b.companyId}::uuid) as criteria,
   (select count(*)::int from public.assignment a where a.tenant_id=${tenant}::uuid
    and a.department_id=any(${uuidArray(empty.map(row=>row.id))}::uuid[])) as references`;
  expect(batch).toEqual({database:admission.database,pid:ownerRealm.pid,backendStart:ownerRealm.backendStart,rows:empty,departments:10,criteria:8,references:0});
  metadata.batch=batch;fit(batchDeadline,0,'committed catalogue receipt');

  state.phase='stress';const stressDeadline=Math.min(stressEnd,performance.now()+18000);persist();
  await snapshot(stressDeadline,1000,async(tx,assertPhase)=>{
   const step=(ms:number,operation:string)=>{assertPhase();fit(stressDeadline,ms+1000,operation);};
   step(500,'stress application metadata');const [identity]=await appWithLimit(tx,'1s');recordIdentity(identity,'500ms');expect(identity.bound).toBe('1s');
   expect(realm(identity)).toEqual(realm(ownerRealm));expect(identity.planner).toEqual(identities[0].planner);
   for(const label of ['broad','sparse'] as const){
    const sparse=label==='sparse',input=sparse?{companyIds:[b.companyId],employmentIds:p.expectedFirst,limit:25}:{companyIds:[],limit:25};
    let statements=0;const capturedStress:{query?:SQL;departmentMs:number}={departmentMs:NaN};
    const guarded=new Proxy(tx,{get(target,key,receiver){
     if(key==='execute')return async(statement:SQL)=>{
      step(1000,label+' product statement');
      const compiled=dialect.sqlToQuery(statement),position=++statements;
      const text=compiled.sql.trimStart();
      const permitted=[text.startsWith('select exists(select 1 from public.app_user'),text.startsWith('with employee_choice_page as materialized'),
       text.startsWith('select "company"."id" as "companyId",')&&!text.includes('cross join'),isDepartmentFacet(text),
       text.startsWith('select "company"."id" as "companyId",')&&text.includes('cross join "business_unit"')];
      if(permitted[position-1]!==true)throw new Error('Unexpected borrowed stress statement at '+position);
      const started=performance.now(),rows=await target.execute(statement);
      if(position===4){
       capturedStress.query=statement;capturedStress.departmentMs=performance.now()-started;
       expect(compiled.params).toEqual(sparse?[tenant,tenant,tenant,tenant,tenant,companyArray,uuidArray(p.expectedFirst)]:[tenant,tenant,tenant,tenant,tenant]);
      }
      return rows;
     };
     const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
    }});
    const started=performance.now(),{contextId:_contextId,...page}=await readEmployeeChoicesTx(guarded,ctx,input,signal),wallMs=performance.now()-started;
    const {query,departmentMs}=capturedStress;
    expect(statements).toBe(5);expect(page).toEqual(stressPage(b,p.expectedFirst,sparse?25:50000));
    const stressResult={label,wallMs,departmentMs,explainMs:NaN,total:page.total,statements,rows:page.rows.length};
    state.stress.push(stressResult);persist();
    if(!query)throw new Error('Actual candidate stress query was not captured');
    step(1000,label+' native plan');const plan=await explain(tx,query,label+'-stress',true,10);
    stressResult.explainMs=plan.executionMs;
   }
   fit(stressDeadline,1000,'stress transaction finalization');
  });
  // Performance outcomes are adjudicated after the admitted observations settle.
  expect(state.matchedImprovement).toEqual({ordinary:true,instrumented:true});
  for(const result of state.stress){
   expect(result.wallMs).toBeLessThanOrEqual(6000);expect(result.departmentMs).toBeLessThanOrEqual(1250);
   expect(result.explainMs).toBeLessThanOrEqual(1000);
  }
 }catch(error){workError=error;}

 state.phase='settlement';
 const cleanupErrors:unknown[]=[];
 const {reservation,realm:ownerRealm}=fixture;
 if(reservation){
  if(fixture.transaction){
   try{fit(end,1000,'fixture rollback',true);await reservation`rollback`;fixture.transaction=false;}catch(error){cleanupErrors.push(error);}
  }
  if(fixture.tightened&&ownerRealm&&!fixture.transaction){
   try{
    fit(end,2000,'real native backend settlement and restore',true);
    const pids=identities.map(identity=>identity.pid);
    const [observed]=await reservation`select current_database() as database,pg_backend_pid() as pid,
     (select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart",
     coalesce((select jsonb_agg(jsonb_build_object('pid',pid,'start',extract(epoch from backend_start)::text,
      'state',state,'outside',xact_start is null)) from pg_stat_activity where datname=current_database()
       and pid=any(${uuidArray(pids.map(String))}::integer[])),'[]'::jsonb) as app`;
    expect(observed).toMatchObject({database:admission.database,pid:ownerRealm.pid,backendStart:ownerRealm.backendStart});
    metadata.settlement=observed;
    for(const identity of identities){
     const row=(observed.app as {pid:number;start:string;state:string;outside:boolean}[]).find(item=>item.pid===identity.pid&&item.start===identity.backendStart);
     if(row)expect(row).toMatchObject({state:'idle',outside:true});
    }
    fit(end,1000,'owner limit restoration',true);
    const [restored]=await reservation`select set_config('statement_timeout',${ownerRealm.statementTimeout},false) as statement,
     set_config('lock_timeout',${ownerRealm.lockTimeout},false) as lock`;
    expect(restored).toEqual({statement:ownerRealm.statementTimeout,lock:ownerRealm.lockTimeout});metadata.ownerRestored=restored;
   }catch(error){cleanupErrors.push(error);}
  }else cleanupErrors.push(new Error('Reserved owner identity or transaction settlement is unconfirmed'));
 }else if(appStarts)cleanupErrors.push(new Error('No verified observer for application settlement'));
 if(identities.length!==appStarts)cleanupErrors.push(new Error('An application checkout ended without a native backend witness'));
 if(performance.now()>end)cleanupErrors.push(new Error('Native settlement deadline elapsed'));
 if(!cleanupErrors.length&&reservation)reservation.release();
 state.settled=cleanupErrors.length===0;
 state.unconfirmed=!state.settled;
 if(state.unconfirmed)allowPoolClose=false;
 state.complete=state.settled&&workError===undefined&&state.plans.length===4&&!signal.aborted;
 state.phase=state.complete?'complete':'failed';
 try{persist();}catch(error){cleanupErrors.push(error);}
 if(workError!==undefined||cleanupErrors.length)throw new AggregateError([...(workError===undefined?[]:[workError]),...cleanupErrors],'Native facet course or owned settlement refused');
 signal.throwIfAborted();expect(state.complete).toBe(true);
}
