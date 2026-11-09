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
const facetIndexName='employee_choice_department_probe_20261109';
const facetIndexDefinition='CREATE INDEX employee_choice_department_probe_20261109 ON public.assignment USING btree (tenant_id, department_id, employment_id) WHERE ((valid_to IS NULL) AND (superseded_at IS NULL))';
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
 extract(epoch from pg_postmaster_start_time())::text as "postmasterStart",
 pg_backend_pid() as pid,(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart",
 current_setting('statement_timeout') as "statementTimeout",current_setting('lock_timeout') as "lockTimeout"`;
type Realm={database:string;databaseOid:string;address:string;port:number;version:string;postmasterStart:string;role:string;login:string;pid:number;backendStart:string;statementTimeout:string;lockTimeout:string};
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
const preparedFacetCounters=sql`(select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) from (
 select name,generic_plans,custom_plans from pg_prepared_statements
 where statement like 'select "company"."id" as "companyId",%cross join "department"%' order by name limit 101) x)`;

const realm=(identity:Realm)=>[identity.database,identity.databaseOid,identity.address,identity.port,identity.version,identity.postmasterStart];
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
 const indexPaths:{node:string;loops:number;condition:string}[]=[];
 let nodes=0,witnesses=0,witnessLoops=0;
 function walk(node:PlanNode,depth:number,insideAssignment=false){
  if(!node||typeof node!=='object'||Array.isArray(node)||++nodes>2048||depth>64||typeof node['Node Type']!=='string')
   throw new Error('Unexpected native facet plan node');
  const isAssignment=node['Relation Name']==='assignment';
  if(isAssignment){
   const qual=['Filter','Index Cond','Recheck Cond'].map(key=>node[key]).filter((value):value is string=>typeof value==='string');
   assignments.push({node:node['Node Type'],loops:measure(node['Actual Loops']),sharedHits:measure(node['Shared Hit Blocks']),qual});
  }
  if(node['Index Name']===facetIndexName){
   indexPaths.push({node:node['Node Type'],loops:measure(node['Actual Loops']),condition:String(node['Index Cond']??'')});
  }
  if(insideAssignment&&node['Relation Name']==='employment'&&measure(node['Actual Loops'])>0){
   const predicates=['Filter','Index Cond','Recheck Cond'].map(key=>node[key]).filter((value):value is string=>typeof value==='string');
   if(predicates.some(value=>value.includes('assignment.employment_id'))){witnesses++;witnessLoops+=measure(node['Actual Loops']);}
  }
  if(node.Plans!==undefined&&!Array.isArray(node.Plans))throw new Error('Unexpected native facet plan children');
  for(const child of node.Plans??[])walk(child,depth+1,insideAssignment||isAssignment);
 }
 const root=document.Plan as PlanNode;
 walk(root,0);
 if(assignmentFirst){
  expect(assignments).toHaveLength(1);
  const [source]=assignments;
  expect(source.loops).toBeGreaterThan(0);expect(source.loops).toBeLessThanOrEqual(maxAssignmentLoops);
  expect(source.qual.some(value=>value.includes('assignment.department_id')&&value.includes('department.id'))).toBe(true);
  expect(witnesses).toBeGreaterThan(0);
 }
 return {planningMs:measure(document['Planning Time']),executionMs:measure(document['Execution Time']),nodes,
  jitReported:Object.hasOwn(document,'JIT'),assignmentNodes:assignments.map(({qual:_qual,...value})=>value),correlatedWitnesses:witnesses,
  witnessLoops,indexPaths,sharedTraffic:measure(root['Shared Hit Blocks'])+measure(root['Shared Read Blocks'])};
}

type FacetIndex={oid:string;name:string;namespace:string;relation:string;owner:string;method:string;definition:string;columns:string[];
 valid:boolean;ready:boolean;live:boolean;unique:boolean;exclusion:boolean};
type PlannerCatalogue={assignmentOid:string;namedOid:string|null;indexes:FacetIndex[];relations:unknown[];columnStats:unknown[];
 extended:unknown[];policies:unknown[];memberships:unknown[];population:Record<string,number>};
type StressLabel='broad'|'sparse';
type IndexEpoch='B0'|'I1'|'I2'|'B1';
type ReservedOwner=Awaited<ReturnType<typeof owner.client.reserve>>;
type OwnerRealm=Realm&{cluster:string;boundStatement:string;boundLock:string};

function facetIndexes(connection:ReservedOwner){
 return connection<FacetIndex[]>`select c.oid::text as oid,c.relname as name,n.nspname as namespace,i.indrelid::text as relation,
  c.relowner::regrole::text as owner,am.amname as method,pg_get_indexdef(c.oid) as definition,
  to_jsonb(array(select a.attname from unnest(i.indkey) with ordinality k(attnum,position)
   left join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum order by position)) as columns,
  i.indisvalid as valid,i.indisready as ready,i.indislive as live,i.indisunique as unique,i.indisexclusion as exclusion
 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
 join pg_am am on am.oid=c.relam where i.indrelid='public.assignment'::regclass order by c.oid limit 101`;
}

async function readFacetPlannerCatalogue(connection:ReservedOwner,tenant:string,finance:string,empty:readonly string[],step:(label:string)=>void){
 step('Assignment index inventory');const indexes=Array.from(await facetIndexes(connection));
 step('planner catalogue');const [facts]=await connection<Omit<PlannerCatalogue,'indexes'>[]>`with relations as materialized (
  select c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reltuples,c.relpages,c.relallvisible
  from pg_class c where c.oid in ('public.assignment'::regclass,'public.employment'::regclass,'public.person'::regclass,
   'public.company'::regclass,'public.department'::regclass)
 ), column_stats as materialized (
  select s.tablename,s.attname,s.inherited,s.null_frac,s.n_distinct,encode(sha256(convert_to(jsonb_build_array(
   s.avg_width,s.most_common_vals::text,s.most_common_freqs,s.histogram_bounds::text,s.correlation,
   s.most_common_elems::text,s.most_common_elem_freqs,s.elem_count_histogram)::text,'UTF8')),'hex') as digest
  from pg_stats s where s.schemaname='public' and s.tablename in (select relname from relations)
   and s.attname in ('id','tenant_id','department_id','employment_id','valid_to','superseded_at','company_id','person_id','voided_at')
  order by s.tablename,s.attname,s.inherited limit 101
 ), extended as materialized (
  select e.oid::text as oid,pg_get_statisticsobjdef(e.oid) as definition,x.inherited,
   encode(sha256(convert_to(jsonb_build_array(x.n_distinct::text,x.dependencies::text,x.most_common_vals,
    x.most_common_val_nulls,x.most_common_freqs,x.most_common_base_freqs)::text,'UTF8')),'hex') as digest
  from pg_statistic_ext e join relations r on r.oid=e.stxrelid join pg_namespace n on n.oid=e.stxnamespace
  left join pg_stats_ext x on x.statistics_schemaname=n.nspname and x.statistics_name=e.stxname
  order by e.oid,x.inherited limit 101
 ) select 'public.assignment'::regclass::oid::text as "assignmentOid",
  to_regclass('public.employee_choice_department_probe_20261109')::oid::text as "namedOid",
  (select jsonb_agg(jsonb_build_array(r.oid::text,r.relname,r.relowner::text,r.relacl::text,r.relrowsecurity,r.relforcerowsecurity,
   r.reltuples,r.relpages,r.relallvisible,s.last_analyze::text,s.last_autoanalyze::text) order by r.oid)
   from relations r join pg_stat_all_tables s on s.relid=r.oid) as relations,
  (select coalesce(jsonb_agg(to_jsonb(s) order by s.tablename,s.attname,s.inherited),'[]'::jsonb) from column_stats s) as "columnStats",
  (select coalesce(jsonb_agg(to_jsonb(x) order by x.oid,x.inherited),'[]'::jsonb) from extended x) as extended,
  (select coalesce(jsonb_agg(to_jsonb(x) order by x.polrelid,x.polname),'[]'::jsonb) from (
   select p.polrelid::text,p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid) as qual,
    pg_get_expr(p.polwithcheck,p.polrelid) as with_check from pg_policy p where p.polrelid in (select oid from relations)
   order by p.polrelid,p.polname limit 101) x) as policies,
  (select coalesce(jsonb_agg(to_jsonb(x) order by x.rolname),'[]'::jsonb) from (
   select r.rolname,r.rolsuper,r.rolbypassrls,pg_has_role('ai_hr_app'::name,r.oid,'MEMBER') as member,
    pg_has_role('ai_hr_app'::name,r.oid,'USAGE') as usable from pg_roles r
   where r.oid in (select unnest(p.polroles) from pg_policy p where p.polrelid in (select oid from relations))
    or r.rolname='ai_hr_app' order by r.rolname limit 101) x) as memberships,
  jsonb_build_object('employees',(select count(*)::int from public.employment where tenant_id=${tenant}::uuid),
   'people',(select count(*)::int from public.person where tenant_id=${tenant}::uuid),
   'assignments',(select count(*)::int from public.assignment where tenant_id=${tenant}::uuid),
   'finance',(select count(*)::int from public.assignment where tenant_id=${tenant}::uuid and department_id=${finance}::uuid),
   'financeCurrent',(select count(*)::int from public.assignment where tenant_id=${tenant}::uuid and department_id=${finance}::uuid
    and valid_to is null and superseded_at is null),
   'emptyReferences',(select count(*)::int from public.assignment where tenant_id=${tenant}::uuid and department_id=any(${uuidArray(empty)}::uuid[])),
   'departments',(select count(*)::int from public.department where tenant_id=${tenant}::uuid)) as population`;
 if(!facts||facts.relations?.length!==5||!facts.columnStats?.length||
  [indexes,facts.columnStats,facts.extended,facts.policies,facts.memberships].some(rows=>!Array.isArray(rows)||rows.length>100))
  throw new Error('Bounded native planner catalogue refused');
 expect(facts.population).toEqual({employees:50000,people:50000,assignments:50000,finance:50000,financeCurrent:50000,emptyReferences:0,departments:10});
 return {...facts,indexes};
}

type Probe={b:Base;ctx:SessionContext;expectedFirst:string[];captured:SQL[];dialect:PgDialect;report:Record<string,unknown>;
 save:()=>void;actual:typeof database.withTenant;caseStart:number;signal:AbortSignal};

async function probeDepartmentFacet(p:Probe,admission:NonNullable<typeof facetAdmission>){
 const {b,ctx,dialect,report,save,signal}=p;
 const probeStart=performance.now(),matchedEnd=probeStart+27000,batchEnd=matchedEnd+5000,stressEnd=batchEnd+18000;
 const caseEnd=p.caseStart+300000;
 let end=stressEnd+10000;
 if(p.caseStart+300000-probeStart<65000)throw new Error('Insufficient original case lifetime for the closed facet probe');
 expect(ctx.entitlements?.tenantStatus).toBe('active');
 expect(ctx.entitlements?.settings?.['audit.hash_chain_enabled']).not.toBe(true);
 expect(process.env.AUDIT_HASH_CHAIN_ENABLED).toBeUndefined();
 const state={source:admission.source,controller:admission.controller,complete:false,settled:false,unconfirmed:false,
  slotMilliseconds:[27000,5000,18000,10000],phase:'matched',plans:[] as Record<string,unknown>[],ordinaryMs:{} as Record<string,number>,
  matchedImprovement:{ordinary:false,instrumented:false},
  stress:[] as {label:string;wallMs:number;departmentMs:number;explainMs?:number;total:number;statements:number;rows:number}[]};
 const indexReceipt={admitted:false,createSent:false,createCommit:false,dropSent:false,dropCommit:false,cleanupDrop:false,
  rollbackAcknowledged:false,indexAbsent:false,restored:false,ownedStopRequired:false};
 const indexAdjudication={complete:false,ordinary:false,instrumented:false,path:false,buffers:false,stressLimits:false};
 const gateStatus:{matched:'unobserved'|'pass'|'fail';baselineStress:'unobserved'|'pass'|'fail';index:'unobserved'|'pass'|'fail'}={
  matched:'unobserved',baselineStress:'unobserved',index:'unobserved'};
 report.facetCandidate=state;
 const rawPlans:{label:string;raw:unknown}[]=[],metadata:Record<string,unknown>={indexReceipt,indexAdjudication,gateStatus,startup:{
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
 const identityReceipts:Record<string,unknown>[]=[];
 let appStarts=0;
 const fixture:{reservation?:ReservedOwner;realm?:OwnerRealm;transaction:boolean;tightened:boolean}={transaction:false,tightened:false};
 let recoverIndex:((deadline:number)=>Promise<void>)|undefined;
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
  const [identity]=await reservation<OwnerRealm[]>`with live as materialized (
    select current_database() as database,d.oid::text as "databaseOid",inet_server_addr()::text as address,
     inet_server_port() as port,current_setting('server_version_num') as version,current_user as role,session_user as login,
     extract(epoch from pg_postmaster_start_time())::text as "postmasterStart",
     (select system_identifier::text from pg_control_system()) as cluster,
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
  expect(identity.cluster).toMatch(/^\d+$/);expect(identity.postmasterStart).toMatch(/^\d+(?:\.\d+)?$/);
  assertBackend(identity);
 };
 const recordIdentity=(identity:AppFacts,ms:string)=>{
  if(!identity)throw new Error('Native application realm is missing');
  assertBackend(identity);identities.push(identity);
  if(identityReceipts.length<2)identityReceipts.push(identity);
  else{
   const {catalogue,...rest}=identity;
   identityReceipts.push({...rest,catalogueSha256:digest(JSON.stringify(catalogue))});
  }
  metadata.app=identityReceipts;
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
  if(rawPlans.length>=10||bytes>1024*1024)throw new Error('Native facet plan inventory or size refused');
  rawPlans.push({label,raw});persist();
  const summary=summarizePlan(raw,first,loops);
  state.plans.push({label,wallMs,...summary});persist();
  return summary;
 };
 const appWithLimit=(tx:Tx,limit:'3s'|'1s')=>{
  const counters=limit==='1s'?sql`, ${preparedFacetCounters} as prepared`:sql``;
  return tx.execute<AppFacts&{bound:string;prepared?:unknown[]}>(sql`with live as materialized (${appFacts}),
   bounded as materialized (select set_config('statement_timeout',${limit},true) as bound from live)
   select live.*,bounded.bound ${counters} from live cross join bounded`);
 };

 let workError:unknown,workFailed=false,matchedObserved=false;
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
   matchedObserved=true;persist();
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

  const ownedBackend=async(step:(label:string)=>void)=>{
   step('reserved owner identity');
   const [identity]=await reservation<(Realm&{cluster:string})[]>`select current_database() as database,
    d.oid::text as "databaseOid",inet_server_addr()::text as address,inet_server_port() as port,
    current_setting('server_version_num') as version,extract(epoch from pg_postmaster_start_time())::text as "postmasterStart",
    current_user as role,session_user as login,pg_backend_pid() as pid,
    (select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart",
    current_setting('statement_timeout') as "statementTimeout",current_setting('lock_timeout') as "lockTimeout",
    (select system_identifier::text from pg_control_system()) as cluster
    from pg_database d where d.datname=current_database()`;
   expect(identity).toMatchObject({database:ownerRealm.database,databaseOid:ownerRealm.databaseOid,address:ownerRealm.address,
    port:ownerRealm.port,version:ownerRealm.version,postmasterStart:ownerRealm.postmasterStart,pid:ownerRealm.pid,
    backendStart:ownerRealm.backendStart,role:'postgres',login:'postgres',statementTimeout:'1s',lockTimeout:'300ms',cluster:ownerRealm.cluster});
  };
  const catalogues:Partial<Record<'B0'|'I'|'B1'|'B1-final'|'cleanup',unknown>>={};
  metadata.indexCatalogues=catalogues;
  const catalogue=async(label:keyof typeof catalogues,step:(operation:string)=>void)=>{
   const facts=await readFacetPlannerCatalogue(reservation,tenant,b.deptA,[b.deptB,...empty.map(row=>row.id)],step);
   const {assignmentOid,namedOid,indexes,population,...plannerFacts}=facts;
   catalogues[label]=label==='B0'?facts:{assignmentOid,namedOid,indexes,population,
    plannerFactSeals:Object.fromEntries(Object.entries(plannerFacts).map(([key,value])=>[key,digest(JSON.stringify(value))]))};
   if(label!=='cleanup')persist();
   return facts;
  };
  const ownerStep=(deadline:number,cleanup=false)=>(operation:string)=>fit(deadline,1000,operation,cleanup);
  const beforeStep=ownerStep(stressEnd);
  await ownedBackend(beforeStep);
  const before=await catalogue('B0',beforeStep);
  expect(before.namedOid).toBeNull();
  expect(before.indexes.some(index=>index.columns[0]==='department_id'||
   index.columns[0]==='tenant_id'&&index.columns[1]==='department_id')).toBe(false);
  expect(before.indexes).toHaveLength(4);
  const comparable=(facts:PlannerCatalogue)=>{
   const {indexes,namedOid:_namedOid,...other}=facts;
   return {...other,indexes:indexes.filter(index=>index.name!==facetIndexName)};
  };
  let created:FacetIndex|undefined;
  const requireIndex=(rows:FacetIndex[])=>{
   const candidates=rows.filter(index=>index.name===facetIndexName);
   expect(candidates).toHaveLength(1);
   const index=candidates[0];
   expect(index).toMatchObject({name:facetIndexName,namespace:'public',relation:before.assignmentOid,owner:'postgres',method:'btree',
    definition:facetIndexDefinition,columns:['tenant_id','department_id','employment_id'],valid:true,ready:true,live:true,unique:false,exclusion:false});
   expect(index.oid).toMatch(/^\d+$/);
   return index;
  };
  const begin=async(step:(operation:string)=>void)=>{
   step('owned index BEGIN');fixture.transaction=true;await reservation`begin`;
   await ownedBackend(step);
  };
  const commit=async(step:(operation:string)=>void)=>{
   step('owned index COMMIT');await reservation`commit`;fixture.transaction=false;
  };
  const namedOid=async(step:(operation:string)=>void)=>{
   step('fixed index namespace identity');
   const [row]=await reservation<{oid:string|null}[]>`select to_regclass('public.employee_choice_department_probe_20261109')::oid::text as oid`;
   if(!row)throw new Error('Missing fixed index namespace witness');
   return row.oid;
  };
  const drop=async(step:(operation:string)=>void,cleanup=false)=>{
   await begin(step);
   step('lock Assignment for owned DROP');await reservation`lock table public.assignment in access exclusive mode`;
   step('owned DROP index identity');const rows=Array.from(await facetIndexes(reservation));
   if(!created)throw new Error('DROP refused without an in-transaction creation identity');
   expect(requireIndex(rows)).toEqual(created);
   step('owned DROP INDEX');indexReceipt.dropSent=true;indexReceipt.cleanupDrop=cleanup;
   await reservation`drop index public.employee_choice_department_probe_20261109`;
   await commit(step);indexReceipt.dropCommit=true;
   if(!cleanup)persist();
  };
  const proveRestored=async(label:'B1'|'cleanup',step:(operation:string)=>void)=>{
   const restored=await catalogue(label,step);
   indexReceipt.indexAbsent=restored.namedOid===null;
   expect(restored).toEqual(before);
   indexReceipt.restored=true;
   if(label!=='cleanup')persist();
  };
  recoverIndex=async(deadline:number)=>{
   if(!indexReceipt.createSent||indexReceipt.restored)return;
   const step=ownerStep(deadline,true);
   await ownedBackend(step);
   const oid=await namedOid(step);
   indexReceipt.indexAbsent=oid===null;
   if(oid!==null){
    if(indexReceipt.dropSent||!created||oid!==created.oid)
     throw new Error('Owned index still present after an ambiguous or refused DROP');
    await drop(step,true);
   }
   await proveRestored('cleanup',step);
  };
  const profiles=['broad','sparse'] as const;
  const baselineQueries:Partial<Record<StressLabel,{query:SQL;seal:{sql:string;parameters:string}}>>={};
  const querySeals:Partial<Record<StressLabel,{sql:string;parameters:string}>>={};
  metadata.indexQuerySeals=querySeals;
  type Observation={epoch:IndexEpoch;label:StressLabel;departmentMs:number;wallMs?:number;statements?:number;rows:number;
   total?:number;dtoVerified:boolean;explainMs?:number;indexAccess?:boolean;sharedTraffic?:number};
  const observations:Observation[]=[];
  metadata.indexObservations=observations;
  const compiledSeal=(query:SQL)=>{
   const {sql:text,params}=dialect.sqlToQuery(query);
   return {sql:digest(text),parameters:digest(JSON.stringify(params))};
  };
  const completePlan=async(tx:Tx,query:SQL,entry:Observation,step:(operation:string)=>void)=>{
   const {epoch,label}=entry;
   step(label+' native plan');
   const plan=await explain(tx,query,epoch==='B0'?label+'-stress':epoch+'-'+label,true,10);
   entry.explainMs=plan.executionMs;entry.sharedTraffic=plan.sharedTraffic;
   entry.indexAccess=plan.indexPaths.some(path=>path.loops>0&&/\bassignment\.tenant_id = /.test(path.condition)&&
    /\bassignment\.department_id = department\.id\b/.test(path.condition));
   if(epoch==='B0'||epoch==='B1')expect(plan.indexPaths).toEqual([]);
   persist();
  };
  const stressIdentity=async(tx:Tx,step:(operation:string,ms?:number)=>void)=>{
   step('stress application metadata',500);
   const [identity]=await appWithLimit(tx,'1s');recordIdentity(identity,'500ms');expect(identity.bound).toBe('1s');
   expect(realm(identity)).toEqual(realm(ownerRealm));expect(identity.planner).toEqual(identities[0].planner);
   expect(identity.prepared?.length).toBeLessThanOrEqual(100);
   return identity;
  };
  const preparedAfter:Partial<Record<'B0'|'I1'|'I2'|'B1',unknown[]>>={};
  metadata.indexPreparedAfter=preparedAfter;
  const readPrepared=async(tx:Tx,epoch:IndexEpoch,step:(operation:string)=>void)=>{
   step(epoch+' native prepared counters');
   const [row]=await tx.execute<{prepared:unknown[]}>(sql`select ${preparedFacetCounters} as prepared`);
   if(!Array.isArray(row?.prepared)||row.prepared.length>100)throw new Error('Native prepared counter bound exceeded');
   preparedAfter[epoch]=row.prepared;persist();
  };
  let baselineIdentity:AppFacts|undefined;
  const sameAppBackend=(identity:AppFacts)=>{
   if(!baselineIdentity)throw new Error('Missing no-index application identity');
   expect([identity.pid,identity.backendStart]).toEqual([baselineIdentity.pid,baselineIdentity.backendStart]);
  };
  const stress=async(tx:Tx,epoch:'B0'|'I1'|'B1',step:(operation:string)=>void)=>{
   for(const label of profiles){
    const sparse=label==='sparse',input=sparse?{companyIds:[b.companyId],employmentIds:p.expectedFirst,limit:25}:{companyIds:[],limit:25};
    let statements=0;const capturedStress:{query?:SQL;departmentMs:number}={departmentMs:NaN};
    const guarded=new Proxy(tx,{get(target,key,receiver){
     if(key==='execute')return async(statement:SQL)=>{
      step(label+' product statement');
      const compiled=dialect.sqlToQuery(statement),position=++statements;
      const text=compiled.sql.trimStart();
      const permitted=[text.startsWith('select exists(select 1 from public.app_user'),text.startsWith('with employee_choice_page as materialized'),
       text.startsWith('select "company"."id" as "companyId",')&&!text.includes('cross join'),isDepartmentFacet(text),
       text.startsWith('select "company"."id" as "companyId",')&&text.includes('cross join "business_unit"')];
      if(permitted[position-1]!==true)throw new Error('Unexpected borrowed stress statement at '+position);
      if(position===4){
       expect(compiled.params).toEqual(sparse?[tenant,tenant,tenant,tenant,tenant,companyArray,uuidArray(p.expectedFirst)]:[tenant,tenant,tenant,tenant,tenant]);
       if(epoch!=='B0')expect(compiledSeal(statement)).toEqual(baselineQueries[label]?.seal);
      }
      const started=performance.now(),rows=await target.execute(statement);
      if(position===4){capturedStress.query=statement;capturedStress.departmentMs=performance.now()-started;}
      return rows;
     };
     const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
    }});
    const started=performance.now(),{contextId:_contextId,...page}=await readEmployeeChoicesTx(guarded,ctx,input,signal),wallMs=performance.now()-started;
    const {query,departmentMs}=capturedStress;
    const entry:Observation={epoch,label,wallMs,departmentMs,total:page.total,statements,rows:page.rows.length,dtoVerified:false};
    observations.push(entry);persist();
    expect(statements).toBe(5);expect(page).toEqual(stressPage(b,p.expectedFirst,sparse?25:50000));
    entry.dtoVerified=true;
    if(!query)throw new Error('Actual candidate stress query was not captured');
    if(epoch==='B0'){
     const seal=compiledSeal(query);
     baselineQueries[label]={query,seal};querySeals[label]=seal;
    }
    persist();
    await completePlan(tx,query,entry,step);
    if(epoch==='B0'){
     state.stress.push({label,wallMs,departmentMs,explainMs:entry.explainMs,total:page.total,statements,rows:page.rows.length});
     persist();
    }
   }
  };
  state.phase='stress';const stressDeadline=Math.min(stressEnd,performance.now()+18000);persist();
  await snapshot(stressDeadline,1000,async(tx,assertPhase)=>{
   const step=(operation:string,ms=1000)=>{assertPhase();fit(stressDeadline,ms+1000,operation);};
   baselineIdentity=await stressIdentity(tx,step);
   await stress(tx,'B0',step);
   await readPrepared(tx,'B0',step);
   fit(stressDeadline,1000,'stress transaction finalization');
  });
  const indexStart=performance.now();
  if(indexStart+65000>caseEnd)throw new Error('Insufficient original case lifetime for the owned index diagnostic');
  end=indexStart+65000;indexReceipt.admitted=true;
  const createEnd=indexStart+7000,indexedEnd=createEnd+23000,dropEnd=indexedEnd+5000,restoredEnd=dropEnd+20000;
  metadata.indexClock={caseEnd,indexStart,createEnd,indexedEnd,dropEnd,restoredEnd,cleanupEnd:end};
  state.phase='index-create';persist();
  const createStep=ownerStep(createEnd);
  await begin(createStep);
  createStep('lock Assignment for owned CREATE');await reservation`lock table public.assignment in share mode`;
  expect(await namedOid(createStep)).toBeNull();
  createStep('owned CREATE INDEX');indexReceipt.createSent=true;
  await reservation`create index employee_choice_department_probe_20261109 on public.assignment(tenant_id,department_id,employment_id)
   where valid_to is null and superseded_at is null`;
  createStep('in-transaction index identity');
  created=requireIndex(Array.from(await facetIndexes(reservation)));metadata.createdIndex=created;persist();
  await commit(createStep);indexReceipt.createCommit=true;persist();

  state.phase='index-observations';persist();
  const indexed=await catalogue('I',ownerStep(indexedEnd));
  expect(indexed.namedOid).toBe(created.oid);expect(requireIndex(indexed.indexes)).toEqual(created);
  expect(comparable(indexed)).toEqual(comparable(before));
  await snapshot(indexedEnd,1000,async(tx,assertPhase)=>{
   const step=(operation:string,ms=1000)=>{assertPhase();fit(indexedEnd,ms+1000,operation);};
   sameAppBackend(await stressIdentity(tx,step));
   await stress(tx,'I1',step);
   await readPrepared(tx,'I1',step);
   for(const label of profiles){
    const saved=baselineQueries[label];
    if(!saved)throw new Error('Missing captured no-index SQL');
    expect(compiledSeal(saved.query)).toEqual(saved.seal);
    step(label+' indexed repeated ordinary statement');
    const started=performance.now(),rows=await tx.execute(saved.query);
    const entry:Observation={epoch:'I2',label,departmentMs:performance.now()-started,rows:rows.length,dtoVerified:false};
    observations.push(entry);persist();
    expect(Array.from(rows)).toEqual(proofRows);entry.dtoVerified=true;persist();
    await completePlan(tx,saved.query,entry,step);
   }
   await readPrepared(tx,'I2',step);
   fit(indexedEnd,1000,'indexed transaction finalization');
  });
  state.phase='index-drop';persist();
  const dropStep=ownerStep(dropEnd);
  await drop(dropStep);
  await proveRestored('B1',dropStep);

  state.phase='index-restored';persist();
  await snapshot(restoredEnd,1000,async(tx,assertPhase)=>{
   const step=(operation:string,ms=1000)=>{assertPhase();fit(restoredEnd,ms+1000,operation);};
   sameAppBackend(await stressIdentity(tx,step));
   await stress(tx,'B1',step);
   await readPrepared(tx,'B1',step);
   fit(restoredEnd,1000,'restored transaction finalization');
  });
  const after=await catalogue('B1-final',ownerStep(restoredEnd));
  expect(after).toEqual(before);
  const observation=(epoch:IndexEpoch,label:StressLabel)=>{
   const entry=observations.find(row=>row.epoch===epoch&&row.label===label);
   if(!entry?.dtoVerified||entry.explainMs===undefined||entry.sharedTraffic===undefined)
    throw new Error('Incomplete indexed comparison observation');
   return {...entry,explainMs:entry.explainMs,sharedTraffic:entry.sharedTraffic};
  };
  const compare=profiles.flatMap(label=>(['I1','I2'] as const).map(epoch=>({
   indexed:observation(epoch,label),before:observation('B0',label),after:observation('B1',label),
  })));
  const every=(check:(indexed:ReturnType<typeof observation>,before:ReturnType<typeof observation>,after:ReturnType<typeof observation>)=>boolean)=>
   compare.every(row=>check(row.indexed,row.before,row.after));
  indexAdjudication.complete=true;
  indexAdjudication.ordinary=every((i,b,a)=>i.departmentMs<b.departmentMs&&i.departmentMs<a.departmentMs);
  indexAdjudication.instrumented=every((i,b,a)=>i.explainMs<b.explainMs&&i.explainMs<a.explainMs);
  indexAdjudication.path=every((i,b,a)=>i.indexAccess===true&&b.indexAccess===false&&a.indexAccess===false);
  indexAdjudication.buffers=every((i,b,a)=>i.sharedTraffic<b.sharedTraffic&&i.sharedTraffic<a.sharedTraffic);
  indexAdjudication.stressLimits=observations.every(row=>(row.wallMs===undefined||row.wallMs<=6000)&&row.departmentMs<=1250&&
   row.explainMs!==undefined&&row.explainMs<=1000);
  persist();
 }catch(error){workFailed=true;workError=error;}

 const gateErrors:unknown[]=[];
 const gate=(name:keyof typeof gateStatus,check:()=>void)=>{
  try{check();gateStatus[name]='pass';}catch(error){gateStatus[name]='fail';gateErrors.push(error);}
 };
 if(matchedObserved)gate('matched',()=>expect(state.matchedImprovement).toEqual({ordinary:true,instrumented:true}));
 if(state.stress.length===2)gate('baselineStress',()=>{
  for(const result of state.stress){
   expect(result.wallMs).toBeLessThanOrEqual(6000);expect(result.departmentMs).toBeLessThanOrEqual(1250);
   expect(result.explainMs).toBeLessThanOrEqual(1000);
  }
 });
 if(indexAdjudication.complete)gate('index',()=>
  expect(indexAdjudication).toEqual({complete:true,ordinary:true,instrumented:true,path:true,buffers:true,stressLimits:true}));

 state.phase='settlement';
 const cleanupErrors:unknown[]=[];
 const {reservation,realm:ownerRealm}=fixture;
 if(reservation){
  const rollbacks:{phase:'active'|'cleanup';acknowledged:boolean}[]=[];
  metadata.rollbacks=rollbacks;
  const rollback=async(phase:'active'|'cleanup')=>{
   try{
    fit(end,1000,'owned '+phase+' rollback',true);
    const receipt={phase,acknowledged:false};rollbacks.push(receipt);
    await reservation`rollback`;fixture.transaction=false;
    receipt.acknowledged=true;indexReceipt.rollbackAcknowledged=true;
   }catch(error){cleanupErrors.push(error);}
  };
  if(fixture.transaction)await rollback('active');
  if(recoverIndex&&!fixture.transaction){
   try{await recoverIndex(end-3000);}catch(error){cleanupErrors.push(error);}
   if(fixture.transaction)await rollback('cleanup');
  }
  if(fixture.tightened&&ownerRealm&&!fixture.transaction){
   try{
    fit(end,2000,'real native backend settlement and restore',true);
    const pids=identities.map(identity=>identity.pid);
    const [observed]=await reservation`select current_database() as database,pg_backend_pid() as pid,
     (select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart",
     extract(epoch from pg_postmaster_start_time())::text as "postmasterStart",
     (select system_identifier::text from pg_control_system()) as cluster,
     coalesce((select jsonb_agg(jsonb_build_object('pid',pid,'start',extract(epoch from backend_start)::text,
      'state',state,'outside',xact_start is null)) from pg_stat_activity where datname=current_database()
       and pid=any(${uuidArray(pids.map(String))}::integer[])),'[]'::jsonb) as app`;
    expect(observed).toMatchObject({database:admission.database,pid:ownerRealm.pid,backendStart:ownerRealm.backendStart,
     postmasterStart:ownerRealm.postmasterStart,cluster:ownerRealm.cluster});
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
 if(indexReceipt.createSent&&!indexReceipt.restored)cleanupErrors.push(new Error('Native index restoration is unconfirmed'));
 if(performance.now()>end)cleanupErrors.push(new Error('Native settlement deadline elapsed'));
 if(!cleanupErrors.length&&reservation){
  try{reservation.release();}catch(error){cleanupErrors.push(error);}
 }
 const errorFact=(error:unknown)=>{
  if(!(error instanceof Error))return {kind:typeof error};
  const code=(error as Error&{code?:unknown}).code;
  return {kind:error.name,code:typeof code==='string'&&/^[A-Z0-9_]{1,40}$/.test(code)?code:null,
   messageSha256:digest(error.message)};
 };
 metadata.failures={work:workFailed?errorFact(workError):null,gates:gateErrors.map(errorFact),cleanup:cleanupErrors.map(errorFact)};
 state.settled=cleanupErrors.length===0;
 state.unconfirmed=!state.settled;
 indexReceipt.ownedStopRequired=state.unconfirmed;
 if(state.unconfirmed)allowPoolClose=false;
 state.complete=state.settled&&!workFailed&&!gateErrors.length&&state.plans.length===10&&indexReceipt.restored&&!signal.aborted;
 state.phase=state.complete?'complete':'failed';
 try{persist();}catch(error){cleanupErrors.push(error);}
 if(workFailed||gateErrors.length||cleanupErrors.length)
  throw new AggregateError([...(workFailed?[workError]:[]),...gateErrors,...cleanupErrors],'Native facet course or owned settlement refused');
 signal.throwIfAborted();expect(state.complete).toBe(true);
}
