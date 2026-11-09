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
import {todayInKualaLumpur} from '../lib/hr-date';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {applicationDatabaseBudget} from '../db/capacity';
import {closeAll,migrateTestDb,owner,type Base} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {departmentFacetBinds,firstWitnessDepartmentFacet,isDepartmentFacet,isSparseDepartmentFacet,sparseDepartmentFacetBinds} from './performance/employee-choice-department-pair-probe';
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
  await probeDepartmentFacet({b,ctx,organisationTagSample,captured,dialect,report,save,actual,caseStart,signal:context.signal},facetAdmission);
 }
 });
 ownedWork=pending;
 context.onTestFinished(async()=>{await pending.catch(()=>{});ownedWork=undefined;});
 return pending;
},300000);

const legacyHash='95900f68e826391eea261670dbeff344a7ef75e2ba921090ceef1ed949de172e';
const firstWitnessHash='409eb5a90dbf1cc91340a9494dd0eb8599b118de5e490de61463b7f629fc8dbb';
const facetIndexName='employee_choice_department_probe_20261109';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
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

type SparseSubject={employmentId:string;ordinal:number};
function stressPage(b:Base,subjects:readonly SparseSubject[]):Omit<EmployeeChoicePage,'contextId'>{
 const finance={id:b.deptA,name:'Finance'};
 return {rows:subjects.map(({employmentId,ordinal})=>{
  const number=String(ordinal).padStart(9,'0');
  return {employmentId,name:'Fictional retained Personnel 人員 '+number,employeeCode:'PERF'+number,
   company:'Acme Sdn Bhd',companyId:b.companyId,department:'Finance',departmentId:b.deptA,departmentCode:null,
   businessUnit:null,businessUnitId:null,businessUnitCode:null,status:'active'};
 }),selected:null,total:subjects.length,offset:0,limit:25,labelMode:'names',filters:{query:'',companyId:'',departmentId:'',businessUnitId:'',status:''},
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
 where statement like 'select "company"."id" as "companyId",%cross join "department"%'
  or statement like 'with authorized_members as materialized (%represented_department_pairs as materialized%'
 order by name limit 101) x)`;

const realm=(identity:Realm)=>[identity.database,identity.databaseOid,identity.address,identity.port,identity.version,identity.postmasterStart];
const assertBackend=(identity:Realm)=>{
 expect(identity.pid).toBeGreaterThan(0);expect(Number.isSafeInteger(identity.pid)).toBe(true);
 expect(identity.backendStart).toMatch(/^\d+(?:\.\d+)?$/);
};

type PlanNode={ [key:string]:unknown; Plans?:PlanNode[] };
const employmentTenantIndexName='company_org_employment_tenant_uq';
type EmploymentPoint={employmentId:string;tenant:string};
function usesEmploymentTenantPointIndex(node:PlanNode,point:EmploymentPoint){
 return node['Node Type']==='Index Scan'&&node.Schema==='public'&&node['Relation Name']==='employment'&&node.Alias==='employment'&&
  node['Index Name']===employmentTenantIndexName&&node['Actual Loops']===1&&node['Actual Rows']===1&&
  node['Rows Removed by Filter']===0&&node['Rows Removed by Index Recheck']===0&&
  node['Index Cond']===`((employment.id = ANY ('{${point.employmentId}}'::uuid[])) AND (employment.tenant_id = '${point.tenant}'::uuid))`;
}

const matchedRelations=['assignment','company','department','employment','person'] as const;
const matchedScans=['Seq Scan','Index Scan'];
const matchedNodes=['Sort','Result','Nested Loop','ProjectSet',...matchedScans];
const knownMatchedPaths={
 'old-assignment-first':'d7725d1f6e9483cfe3c4127524d68a17a3051cf18f011e4ad46e031d677b7f74',
 'old-employment-first':'89400a082d46fb1d76e97635b382f8c5bef20ea8ce88a5c6f15098420e7b73cb',
 'candidate-assignment-first-primary-key':'160798ba0e9b1612178ba2bab626d93f286f20c2ea95b73a6bbd980cf3c7ed96',
 'candidate-assignment-first-tenant-key':'ccdbf6250eff201c6570ededb10fd765a9bcdd4735affb3e4c7fa1dc1d49941f',
} as const;
type MatchedPath=keyof typeof knownMatchedPaths;
type MatchedScope={label:'old-matched'|'candidate-matched';tenant:string;company:string};
const matchedVariableCounters=new Set(['Startup Cost','Total Cost','Plan Rows','Plan Width','Shared Hit Blocks','Shared Read Blocks',
 'Rows Removed by Filter','Rows Removed by Index Recheck']);
const planCounter=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
type MatchedAccess={relation:string;kind:string;index:string|null;loops:number;rows:number;filtered:number;rechecked:number|null};
type MatchedFacetWork={
 access:MatchedAccess[];policy:[number,number][];joinRemovals:[number,number][];sharedHits:number;sharedReads:number;
};
type MatchedFacetArm={path:MatchedPath;label:MatchedScope['label'];work:MatchedFacetWork};

/** Identify a reviewed access path while retaining native reference relationships. */
function knownMatchedPath(root:PlanNode,scope:MatchedScope):MatchedPath|null{
 const references=new Map<string,number>(),shape:unknown[]=[];
 const normalize=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(normalize);
  if(typeof value!=='string')return value;
  return value.replaceAll(scope.tenant,'<tenant>').replaceAll(scope.company,'<company>')
   .replace(/(InitPlan|SubPlan) (\d+)|\$(\d+)/g,(_match,kind:string|undefined,plan:string|undefined,param:string|undefined)=>{
    const key=plan?'p'+plan:'$'+param;
    if(!references.has(key))references.set(key,references.size+1);
    return plan?String(kind)+' @'+references.get(key):'$@'+references.get(key);
   });
 };
 function walk(node:PlanNode,depth:number):boolean{
  if(node['Actual Loops']===0)return (node.Plans??[]).every(child=>child['Actual Loops']===0&&walk(child,depth+1));
  const scan=matchedScans.includes(String(node['Node Type']));
  const fields=[];
  for(const key of Object.keys(node).sort()){
   if(key==='Plans')continue;
   const value=node[key];
   const measured=matchedVariableCounters.has(key)||(scan&&(key==='Actual Loops'||key==='Actual Rows'));
   if(measured&&(typeof value!=='number'||!Number.isFinite(value)||value<0))return false;
   fields.push([key,measured?null:normalize(value)]);
  }
  shape.push([depth,fields]);
  return (node.Plans??[]).every(child=>walk(child,depth+1));
 }
 if(!walk(root,0))return null;
 const hash=digest(JSON.stringify(shape));
 if(scope.label==='old-matched'){
  if(hash===knownMatchedPaths['old-assignment-first'])return 'old-assignment-first';
  if(hash===knownMatchedPaths['old-employment-first'])return 'old-employment-first';
 }else if(scope.label==='candidate-matched'){
  if(hash===knownMatchedPaths['candidate-assignment-first-primary-key'])return 'candidate-assignment-first-primary-key';
  if(hash===knownMatchedPaths['candidate-assignment-first-tenant-key'])return 'candidate-assignment-first-tenant-key';
 }
 return null;
}

function matchedFacetWork(document:Record<string,unknown>,root:PlanNode,nodes:PlanNode[],scope:MatchedScope):MatchedFacetArm|null{
 if(root['Node Type']!=='Sort'||root['Actual Loops']!==1||root['Actual Rows']!==1||root['Sort Space Type']!=='Memory'||
    Object.hasOwn(document,'JIT')||nodes.some(node=>!planCounter(node['Actual Loops'])))return null;
 const active=nodes.filter(node=>(node['Actual Loops'] as number)>0);
 if(active.some(node=>!matchedNodes.includes(String(node['Node Type']))||!planCounter(node['Actual Rows'])||
    node['Parallel Aware']!==false||node['Async Capable']!==false||node['Temp Read Blocks']!==0||node['Temp Written Blocks']!==0||
    node['Local Hit Blocks']!==0||node['Local Read Blocks']!==0||node['Local Dirtied Blocks']!==0||node['Local Written Blocks']!==0||
    node['Shared Dirtied Blocks']!==0||node['Shared Written Blocks']!==0))return null;
 const path=knownMatchedPath(root,scope);
 if(!path)return null;
 const opposite=scope.label==='old-matched'?'candidate-matched':'old-matched';
 expect(knownMatchedPath(root,{...scope,label:opposite})).toBeNull();
 const [result]=root.Plans??[],[join]=result.Plans??[];
 const withoutCounter={...result};delete withoutCounter['Shared Hit Blocks'];
 for(const changed of [
  {...root,Plans:[result,{...result,Plans:[],'Actual Loops':50000}]},
  {...root,Plans:[{...result,Plans:[join,{...join,Plans:[]}]}]},
  {...root,Plans:[{...result,'One-Time Filter':String(result['One-Time Filter'])+' AND true'}]},
  {...root,Plans:[withoutCounter]},
 ])expect(knownMatchedPath(changed,scope)).toBeNull();
 const access=active.filter(node=>matchedScans.includes(String(node['Node Type'])));
 if(access.length!==matchedRelations.length)return null;
 const scans:MatchedAccess[]=[];
 for(const relation of matchedRelations){
  const matches=access.filter(node=>node['Relation Name']===relation);
  if(matches.length!==1)return null;
  const [node]=matches,kind=node['Node Type'],index=node['Index Name'],loops=node['Actual Loops'] as number;
  const filtered=node['Rows Removed by Filter'],rechecked=node['Rows Removed by Index Recheck'];
  if(node.Schema!=='public'||node.Alias!==relation||!planCounter(filtered)||
     (kind==='Seq Scan'?index!==undefined||rechecked!==undefined:typeof index!=='string'||!planCounter(rechecked)))return null;
  scans.push({relation,kind:String(kind),index:typeof index==='string'?index:null,loops,
   rows:node['Actual Rows'] as number,filtered,rechecked:planCounter(rechecked)?rechecked:null});
 }
 const policy:MatchedFacetWork['policy']=[],joinRemovals:MatchedFacetWork['joinRemovals']=[];
 for(const node of active){
  const loops=node['Actual Loops'] as number,rows=node['Actual Rows'] as number;
  if(node['Node Type']==='ProjectSet'){
   const output=node.Output;
   if(!Array.isArray(output)||output.length!==1||typeof output[0]!=='string'||!/^unnest\(\$\d+\)$/.test(output[0]))return null;
   policy.push([loops,rows]);
  }
  if(node['Node Type']==='Nested Loop'){
   const removed=node['Rows Removed by Join Filter']??0;
   if(node['Join Type']!=='Inner'||!planCounter(removed))return null;
   if(removed>0)joinRemovals.push([loops,removed]);
  }
 }
 const sharedHits=root['Shared Hit Blocks'],sharedReads=root['Shared Read Blocks'];
 if(!policy.length||!planCounter(sharedHits)||!planCounter(sharedReads))return null;
 return {path,label:scope.label,work:{access:scans,policy:policy.sort(),joinRemovals:joinRemovals.sort(),sharedHits,sharedReads}};
}

function matchedFacetOutcome(old:MatchedFacetWork|null,candidate:MatchedFacetWork|null,elapsed:{ordinary:boolean;instrumented:boolean}){
 if(!old||!candidate)return 'refused';
 if(JSON.stringify(old)===JSON.stringify(candidate))return 'equivalent-work';
 if(candidate.access[0].loops<old.access[0].loops&&candidate.sharedHits+candidate.sharedReads<old.sharedHits+old.sharedReads&&
    candidate.access.slice(1).every((entry,index)=>{
     const previous=old.access[index+1];
     return entry.loops<=previous.loops&&entry.rows<=previous.rows&&entry.filtered<=previous.filtered&&
      (entry.rechecked??0)<=(previous.rechecked??0);
    })&&JSON.stringify(candidate.policy)===JSON.stringify(old.policy)&&JSON.stringify(candidate.joinRemovals)===JSON.stringify(old.joinRemovals)&&
    elapsed.ordinary&&elapsed.instrumented)return 'improved';
 return 'refused';
}

function correlatedMatchedOutcome(old:MatchedFacetArm|null,candidate:MatchedFacetArm|null,elapsed:{ordinary:boolean;instrumented:boolean}){
 if(!old||!candidate||old.label!=='old-matched'||candidate.label!=='candidate-matched')return 'refused';
 const parity=old.path==='old-assignment-first'&&candidate.path==='candidate-assignment-first-primary-key';
 const changedWork=old.path==='old-employment-first'&&
  (candidate.path==='candidate-assignment-first-primary-key'||candidate.path==='candidate-assignment-first-tenant-key');
 if(!parity&&!changedWork)return 'refused';
 const outcome=matchedFacetOutcome(old.work,candidate.work,elapsed);
 if((parity&&outcome==='equivalent-work')||(changedWork&&outcome==='improved'))return outcome;
 return 'refused';
}

function summarizePlan(raw:unknown,assignmentFirst:boolean,maxAssignmentLoops:number,sparseCount?:number,point?:EmploymentPoint,matched?:MatchedScope){
 if(!Array.isArray(raw)||raw.length!==1||!raw[0]||typeof raw[0]!=='object')throw new Error('Unexpected native facet plan envelope');
 const document=raw[0] as Record<string,unknown>;
 const measure=(value:unknown)=>{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('Invalid native facet plan counter');
  return value;
 };
 const assignments:{node:string;loops:number;sharedHits:number;qual:string[]}[]=[];
 const shapeNodes:PlanNode[]=[];
 const indexPaths:{node:string;loops:number;condition:string}[]=[];
 let nodes=0,witnesses=0,witnessLoops=0;
 function walk(node:PlanNode,depth:number,insideAssignment=false){
  if(!node||typeof node!=='object'||Array.isArray(node)||++nodes>2048||depth>64||typeof node['Node Type']!=='string')
   throw new Error('Unexpected native facet plan node');
  shapeNodes.push(node);
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
  witnessLoops,indexPaths,sharedTraffic:measure(root['Shared Hit Blocks'])+measure(root['Shared Read Blocks']),
  ...(matched?{matchedWork:matchedFacetWork(document,root,shapeNodes,matched)}:{}),
  pathRefusals:sparseCount===undefined?[]:sparsePathRefusals(sparseCount,shapeNodes,root,measure,point)};
}

function sparsePathRefusals(expected:number,nodes:PlanNode[],root:PlanNode,measure:(value:unknown)=>number,point?:EmploymentPoint){
 const active=nodes.filter(node=>measure(node['Actual Loops'])>0),refusals:string[]=[];
 const once=(matches:PlanNode[])=>matches.length===1&&measure(matches[0]['Actual Loops'])===1;
 const reads=(name:string)=>active.filter(node=>node['Node Type']==='CTE Scan'&&node['CTE Name']===name);
 const authority=active.filter(node=>node['Subplan Name']==='CTE authorized_members');
 const pairs=active.filter(node=>node['Subplan Name']==='CTE represented_department_pairs');
 const members=reads('authorized_members');
 if(!once(pairs)||pairs[0]['Actual Rows']!==1||root['Actual Rows']!==1)refusals.push('pair-output');
 if(!once(authority)||authority[0]['Actual Rows']!==expected||!once(members)||members[0]['Actual Rows']!==expected)
  refusals.push('bounded-authority-read');
 if(active.some(node=>measure(node['Temp Read Blocks'])>0||measure(node['Temp Written Blocks'])>0||
   (typeof node['Hash Batches']==='number'&&node['Hash Batches']>1)||
   (typeof node['Disk Usage']==='number'&&node['Disk Usage']>0)))refusals.push('temporary-work');
 // CTE producers are InitPlans. Within each producer, policy subplans are separate
 // from its physical witness tree, even when PostgreSQL reuses a relation alias.
 const witnessNodes=(node:PlanNode):PlanNode[]=>[node,...(node.Plans??[])
  .filter(child=>!['InitPlan','SubPlan'].includes(String(child['Parent Relationship']))).flatMap(witnessNodes)];
 const witnesses=(producer:PlanNode|undefined,relation:string)=>producer
  ?witnessNodes(producer).filter(node=>node['Relation Name']===relation&&measure(node['Actual Loops'])>0):[];
 const byIndex=(node:PlanNode,indexes:readonly string[],condition:(text:string)=>boolean)=>{
  const matches=(entry:PlanNode)=>indexes.includes(String(entry['Index Name']))&&condition(String(entry['Index Cond']));
  return (node['Node Type']==='Index Scan'||node['Node Type']==='Index Only Scan')&&matches(node)||
   node['Node Type']==='Bitmap Heap Scan'&&node.Plans?.some(child=>child['Node Type']==='Bitmap Index Scan'&&
    child['Actual Loops']===node['Actual Loops']&&matches(child))===true;
 };
 const equality=(text:string,left:string,right:string)=>{
  const condition=text.replace(/[()\s]/g,'');
  return condition===left+'='+right||condition===right+'='+left;
 };
 const employments=witnesses(authority[0],'employment'),[employmentNode]=employments;
 const people=witnesses(authority[0],'person'),[personNode]=people;
 const employmentAlias=String(employmentNode?.Alias),personAlias=String(personNode?.Alias);
 if(!once(employments)||employmentNode['Actual Rows']!==expected||
  !(byIndex(employmentNode,['employment_pkey'],condition=>condition.startsWith('('+employmentAlias+'.id = ANY ('))||
    expected===1&&point&&usesEmploymentTenantPointIndex(employmentNode,point)))
  refusals.push('sparse-employment-primary-path');
 if(people.length!==1||personNode['Actual Loops']!==expected||personNode['Actual Rows']!==1||
  !byIndex(personNode,['person_pkey'],condition=>equality(condition,personAlias+'.id',employmentAlias+'.person_id')))
  refusals.push('sparse-person-primary-path');
 const assignments=witnesses(pairs[0],'assignment'),[assignmentNode]=assignments;
 if(assignments.length!==1||assignmentNode['Actual Loops']!==expected||assignmentNode['Actual Rows']!==1||
  !byIndex(assignmentNode,['assignment_employment_idx','assignment_no_overlap'],
   condition=>equality(condition,String(assignmentNode.Alias)+'.employment_id',String(members[0]?.Alias)+'.employment_id')))
  refusals.push('sparse-employment-key-path');
 return refusals;
}

type FacetIndex={oid:string;name:string;namespace:string;relation:string;owner:string;method:string;definition:string;columns:string[];
 valid:boolean;ready:boolean;live:boolean;unique:boolean;exclusion:boolean};
type PlannerCatalogue={assignmentOid:string;namedOid:string|null;indexes:FacetIndex[];employmentTenantIndex:FacetIndex|null;relations:unknown[];columnStats:unknown[];
 extended:unknown[];policies:unknown[];memberships:unknown[];population:Record<string,number>};
type StressLabel='one-id'|'twenty-five-ids';
type PairEpoch='A0'|'B0'|'B1'|'A1';
type ReservedOwner=Awaited<ReturnType<typeof owner.client.reserve>>;
type OwnerRealm=Realm&{cluster:string;boundStatement:string;boundLock:string};

function facetIndexes(connection:ReservedOwner){
 return connection<FacetIndex[]>`select c.oid::text as oid,c.relname as name,n.nspname as namespace,i.indrelid::text as relation,
  c.relowner::regrole::text as owner,am.amname as method,pg_get_indexdef(c.oid) as definition,
  to_jsonb(array(select a.attname from unnest(i.indkey) with ordinality k(attnum,position)
   left join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum order by position)) as columns,
  i.indisvalid as valid,i.indisready as ready,i.indislive as live,i.indisunique as unique,i.indisexclusion as exclusion
 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
 join pg_am am on am.oid=c.relam
 where i.indrelid='public.assignment'::regclass
  or (i.indrelid='public.employment'::regclass and n.nspname='public' and c.relname=${employmentTenantIndexName})
 order by c.oid limit 102`;
}

async function readFacetPlannerCatalogue(connection:ReservedOwner,tenant:string,finance:string,empty:readonly string[],step:(label:string)=>void){
 step('Assignment index inventory');const inventory=Array.from(await facetIndexes(connection));
 step('planner catalogue');const [facts]=await connection<Omit<PlannerCatalogue,'indexes'|'employmentTenantIndex'>[]>`with relations as materialized (
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
 const indexes=inventory.filter(index=>index.relation===facts?.assignmentOid);
 const employmentIndexes=inventory.filter(index=>index.relation!==facts?.assignmentOid);
 if(!facts||employmentIndexes.length>1||facts.relations?.length!==5||!facts.columnStats?.length||
  [indexes,facts.columnStats,facts.extended,facts.policies,facts.memberships].some(rows=>!Array.isArray(rows)||rows.length>100))
  throw new Error('Bounded native planner catalogue refused');
 expect(facts.population).toEqual({employees:50000,people:50000,assignments:50000,finance:50000,financeCurrent:50000,emptyReferences:0,departments:10});
 return {...facts,indexes,employmentTenantIndex:employmentIndexes[0]??null};
}

type Probe={b:Base;ctx:SessionContext;organisationTagSample:string[];captured:SQL[];dialect:PgDialect;report:Record<string,unknown>;
 save:()=>void;actual:typeof database.withTenant;caseStart:number;signal:AbortSignal};

async function probeDepartmentFacet(p:Probe,admission:NonNullable<typeof facetAdmission>){
 const {b,ctx,dialect,report,save,signal}=p;
 const probeStart=performance.now(),matchedEnd=probeStart+27000,batchEnd=matchedEnd+5000,stressEnd=batchEnd+18000;
 const caseEnd=p.caseStart+300000,activeEnd=Math.min(stressEnd+30000,caseEnd-10000);
 const end=activeEnd+10000;
 if(caseEnd-probeStart<65000)throw new Error('Insufficient original case lifetime for the closed facet probe');
 expect(ctx.entitlements?.tenantStatus).toBe('active');
 expect(ctx.entitlements?.settings?.['audit.hash_chain_enabled']).not.toBe(true);
 expect(process.env.AUDIT_HASH_CHAIN_ENABLED).toBeUndefined();
 const state={source:admission.source,controller:admission.controller,complete:false,settled:false,unconfirmed:false,
  slotMilliseconds:[27000,5000,18000,10000],phase:'matched',plans:[] as Record<string,unknown>[],ordinaryMs:{} as Record<string,number>,
  matchedImprovement:{ordinary:false,instrumented:false},
  matchedOutcome:'refused' as ReturnType<typeof correlatedMatchedOutcome>,
  stress:[] as {label:string;wallMs:number;departmentMs:number;explainMs?:number;total:number;statements:number;rows:number}[]};
 const pairStatus={complete:false,catalogueUnchanged:false,ownedStopRequired:false,
  twoDepartmentSparseProduct:'unobserved; original matched statements are retained'};
 const gateStatus:{matched:'unobserved'|'pass'|'fail'|'equivalent-work';sparseBaselineStress:'unobserved'|'pass'|'fail';
  sparseProductPairs:'unobserved'|'pass'|'fail'}={matched:'unobserved',sparseBaselineStress:'unobserved',sparseProductPairs:'unobserved'};
 report.facetCandidate=state;
 const historicalBroad={
  source:'a2936e6ba64695c4f92e277a69545e3d66c7673b',runId:42556631701,
  artifactSha256:'4938a1d1bc8f7a84ea615cfe96813b730fc5b56acfe2b32bd03182d8f74a5c62',
  gateStatus:{baselineStress:'pass',representedPairs:'fail'},
  broad:'Ordinary, instrumented and whole-page relative times failed; both structural refusals misread the native Employment alias.',
 };
 const rawPlans:{label:string;raw:unknown}[]=[],metadata:Record<string,unknown>={pairStatus,gateStatus,historicalBroad,startup:{
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
  const path=join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'employee-choice-department-pairs-private.json');
  writeFileSync(path,JSON.stringify({kind:'FICTIONAL_NATIVE_SPARSE_PRODUCT_DEPARTMENT_PAIRS_DIAGNOSTIC',metadata,rawPlans}),{mode:0o600});
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
 expect(isDepartmentFacet(compiled.sql)).toBe(true);expect(digest(compiled.sql)).toBe(firstWitnessHash);
 expect(compiled).toEqual(dialect.sqlToQuery(firstWitnessDepartmentFacet(tenant,{companyIds:[b.companyId]})));
 expect(p.captured.map(query=>dialect.sqlToQuery(query))).toEqual(p.captured.map(()=>compiled));
 metadata.sql={legacy:legacyHash,candidate:digest(compiled.sql),parameterCount:6};
 const proofRows=[{companyId:b.companyId,company:'Acme Sdn Bhd',departmentId:b.deptA,departmentCode:null,department:'Finance',
  businessUnitId:null,businessUnitCode:null,businessUnit:null}];
 const identities:AppFacts[]=[];
 const identityReceipts:Record<string,unknown>[]=[];
 let appStarts=0;
 const fixture:{reservation?:ReservedOwner;realm?:OwnerRealm;transaction:boolean;tightened:boolean}={transaction:false,tightened:false};
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
 const snapshot=async(deadline:number,finalMs:number,work:(tx:Tx,assertPhase:()=>void)=>Promise<void>,settleBy=deadline)=>{
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
   fit(settleBy,0,'settled application transaction');
  }catch(error){frontier.abort(error);throw error;}finally{
   clearTimeout(timer);
   // postgres.js begin can reject on connection close before its callback ends.
   await pending.callback?.catch(()=>{});
  }
 };
 const explain=async(tx:Tx,query:SQL,label:string,first:boolean,loops:number,sparseCount?:number,point?:EmploymentPoint)=>{
  const started=performance.now();
  const rows=await tx.execute<{ 'QUERY PLAN':unknown }>(sql`explain(analyze,buffers,verbose,settings,timing off,format json) ${query}`);
  const wallMs=performance.now()-started;
  expect(rows).toHaveLength(1);
  const raw=rows[0]['QUERY PLAN'];
  const bytes=Buffer.byteLength(JSON.stringify(raw));
  if(rawPlans.length>=10||bytes>1024*1024)throw new Error('Native facet plan inventory or size refused');
  rawPlans.push({label,raw});persist();
  const matched:MatchedScope|undefined=label==='old-matched'||label==='candidate-matched'?{label,tenant,company:b.companyId}:undefined;
  const summary=summarizePlan(raw,first,loops,sparseCount,point,matched);
  state.plans.push({label,wallMs,...summary});persist();
  return summary;
 };
 const appWithLimit=(tx:Tx,limit:'3s'|'1s')=>{
  const counters=limit==='1s'?sql`, ${preparedFacetCounters} as prepared`:sql``;
  return tx.execute<AppFacts&{bound:string;prepared?:unknown[]}>(sql`with live as materialized (${appFacts}),
   bounded as materialized (select set_config('statement_timeout',${limit},true) as bound from live)
   select live.*,bounded.bound ${counters} from live cross join bounded`);
 };

 const gateErrors:unknown[]=[];
 const gate=(name:keyof typeof gateStatus,check:()=>void)=>{
  try{check();gateStatus[name]='pass';}catch(error){gateStatus[name]='fail';gateErrors.push(error);}
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
   const oldArm=oldPlan.matchedWork??null,candidateArm=candidatePlan.matchedWork??null;
   state.matchedOutcome=correlatedMatchedOutcome(oldArm,candidateArm,state.matchedImprovement);
   metadata.matchedWorkOutcome={outcome:state.matchedOutcome,
    oldPath:oldArm?.path??null,candidatePath:candidateArm?.path??null,
    elapsed:state.matchedOutcome==='improved'?'both-faster-in-this-run':'single-pair-inconclusive'};
   const oldWork=oldArm?.work;
   if(oldWork){
    const opposed={ordinary:false,instrumented:true},bothFaster={ordinary:true,instrumented:true};
    expect(matchedFacetOutcome(oldWork,oldWork,opposed)).toBe('equivalent-work');
    expect(matchedFacetOutcome(oldWork,null,bothFaster)).toBe('refused');
    expect(matchedFacetOutcome(oldWork,{...oldWork,sharedHits:oldWork.sharedHits+1},bothFaster)).toBe('refused');
    const [assignment,...other]=oldWork.access;
    const moreLoops={...oldWork,access:[{...assignment,loops:assignment.loops+1},...other],sharedHits:oldWork.sharedHits+1};
    expect(matchedFacetOutcome(moreLoops,oldWork,opposed)).toBe('refused');
    expect(matchedFacetOutcome(moreLoops,oldWork,bothFaster)).toBe('improved');
    // Model the eligibility matrix using the observed counters. The real verdict above only uses native arms.
    const oldLight:MatchedFacetArm={path:'old-assignment-first',label:'old-matched',work:oldWork};
    const oldHeavy:MatchedFacetArm={...oldLight,path:'old-employment-first',work:moreLoops};
    const primaryKey:MatchedFacetArm={path:'candidate-assignment-first-primary-key',label:'candidate-matched',work:oldWork};
    const tenantKey:MatchedFacetArm={...primaryKey,path:'candidate-assignment-first-tenant-key'};
    expect(correlatedMatchedOutcome(oldLight,primaryKey,opposed)).toBe('equivalent-work');
    expect(correlatedMatchedOutcome(oldLight,tenantKey,bothFaster)).toBe('refused');
    expect(correlatedMatchedOutcome(primaryKey,oldHeavy,bothFaster)).toBe('refused');
    expect(correlatedMatchedOutcome(null,primaryKey,bothFaster)).toBe('refused');
    expect(correlatedMatchedOutcome({...oldHeavy,work:oldWork},primaryKey,bothFaster)).toBe('refused');
    expect(correlatedMatchedOutcome({...oldLight,work:moreLoops},primaryKey,bothFaster)).toBe('refused');
    for(const light of [primaryKey,tenantKey]){
     expect(correlatedMatchedOutcome(oldHeavy,light,bothFaster)).toBe('improved');
     expect(correlatedMatchedOutcome(oldHeavy,light,opposed)).toBe('refused');
     expect(correlatedMatchedOutcome(oldHeavy,light,{ordinary:true,instrumented:false})).toBe('refused');
     const supportingRegression={...light.work,access:light.work.access.map((entry,index)=>index===1?{...entry,loops:entry.loops+1}:entry)};
     expect(correlatedMatchedOutcome(oldHeavy,{...light,work:supportingRegression},bothFaster)).toBe('refused');
    }
   }
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
  fixture.transaction=true;await reservation`begin`;
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
  const beforeStep=(operation:string)=>fit(stressEnd,1000,operation);
  await ownedBackend(beforeStep);
  const emptyIds=[b.deptB,...empty.map(row=>row.id)];
  const before=await readFacetPlannerCatalogue(reservation,tenant,b.deptA,emptyIds,beforeStep);
  metadata.plannerBefore=before;persist();
  expect(before.namedOid).toBeNull();
  expect(before.indexes.some(index=>index.columns[0]==='department_id'||
   index.columns[0]==='tenant_id'&&index.columns[1]==='department_id')).toBe(false);
  expect(before.indexes.map(index=>index.name).sort()).toEqual(
   ['assignment_company_idx','assignment_employment_idx','assignment_no_overlap','assignment_pkey']);
  expect(before.indexes.every(index=>index.valid&&index.ready&&index.live)).toBe(true);
  const employmentIndex=before.employmentTenantIndex;
  const employmentRelation=before.relations.find(row=>Array.isArray(row)&&row[1]==='employment');
  const expectedDefinitions=['public.employment','employment'].map(relation=>
   `CREATE UNIQUE INDEX ${employmentTenantIndexName} ON ${relation} USING btree (id, tenant_id)`);
  const tenantPointEligible=Array.isArray(employmentRelation)&&employmentIndex!==null&&
   /^\d+$/.test(employmentIndex.oid)&&employmentIndex.relation===employmentRelation[0]&&
   employmentIndex.name===employmentTenantIndexName&&employmentIndex.namespace==='public'&&
   employmentIndex.method==='btree'&&employmentIndex.unique&&employmentIndex.valid&&employmentIndex.ready&&employmentIndex.live&&
   !employmentIndex.exclusion&&employmentIndex.columns.length===2&&employmentIndex.columns[0]==='id'&&employmentIndex.columns[1]==='tenant_id'&&
   expectedDefinitions.includes(employmentIndex.definition);

  const terminatedAfter=todayInKualaLumpur();
  expect(terminatedAfter>='2024-01-01').toBe(true);
  const activeSample=p.organisationTagSample.map((employmentId,index)=>({employmentId,ordinal:index+1}))
   .filter(({ordinal})=>ordinal%5!==0).slice(0,25);
  expect(activeSample).toHaveLength(25);
  const profiles=['one-id','twenty-five-ids'] as const;
  const subjects={'one-id':activeSample.slice(0,1),'twenty-five-ids':activeSample};
  const epochs=['A0','B0','B1','A1'] as const;
  type CompiledQuery=ReturnType<PgDialect['sqlToQuery']>;
  type Seal={sql:string;parameters:string};
  const compiledSeal=({sql:text,params}:CompiledQuery):Seal=>({sql:digest(text),parameters:digest(JSON.stringify(params))});
  // Build and attest each fixed reference outside every measured arm.
  const references=Object.fromEntries(profiles.map(label=>{
   const input=Object.freeze({companyIds:Object.freeze([b.companyId]),terminatedAfter,
    employmentIds:Object.freeze(subjects[label].map(row=>row.employmentId)),limit:25});
   const baseline=firstWitnessDepartmentFacet(tenant,input);
   Object.freeze(baseline.queryChunks);Object.freeze(baseline);
   const compiled=dialect.sqlToQuery(baseline);
   expect(isDepartmentFacet(compiled.sql)).toBe(true);
   expect(compiled.params).toEqual(departmentFacetBinds(tenant,input));
   const point=label==='one-id'&&tenantPointEligible?{employmentId:input.employmentIds[0],tenant}:undefined;
   return [label,{input,baseline,point,seal:Object.freeze(compiledSeal(compiled)),
    productBinds:Object.freeze(sparseDepartmentFacetBinds(tenant,input))}] as const;
  }));
  type Observation={epoch:PairEpoch;label:StressLabel;departmentMs:number;wallMs:number;statements:number;rows:number;
   total:number;dtoVerified:boolean;executed:'product-forwarded'|'a293-first-witness-reference';explainMs?:number;sharedTraffic?:number;pathRefusals?:string[]};
  const productSeals:Partial<Record<StressLabel,Seal[]>>={};
  const baselineSeals=Object.fromEntries(profiles.map(label=>[label,references[label].seal]));
  const observations:Observation[]=[];
  const prepared:Partial<Record<PairEpoch,unknown[]>>={};
  metadata.pairObservations=observations;metadata.productQuerySeals=productSeals;metadata.baselineQuerySeals=baselineSeals;metadata.prepared=prepared;
  metadata.sparseProfiles=profiles.map(label=>({label,terminatedAfter,scopeSize:subjects[label].length}));
  const stress=async(tx:Tx,epoch:PairEpoch,step:(operation:string,ms?:number)=>void)=>{
   const candidateEpoch=epoch==='B0'||epoch==='B1';
   const order=epoch==='B0'||epoch==='A1'?[...profiles].reverse():profiles;
   for(const label of order){
    const scoped=subjects[label];
    const {input,baseline,point,seal,productBinds}=references[label];
    const statements:{query:SQL;compiled:CompiledQuery}[]=[];
    const captured:{forwarded?:SQL;rows?:readonly unknown[];departmentMs:number}={departmentMs:NaN};
    const guarded=new Proxy(tx,{get(target,key,receiver){
     if(key==='execute')return async(statement:SQL)=>{
      step(label+' product statement');
      const compiled=dialect.sqlToQuery(statement),position=statements.push({query:statement,compiled});
      const text=compiled.sql.trimStart();
      const permitted=[text.startsWith('select exists(select 1 from public.app_user'),text.startsWith('with employee_choice_page as materialized'),
       text.startsWith('select "company"."id" as "companyId",')&&!text.includes('cross join'),isSparseDepartmentFacet(text),
       text.startsWith('select "company"."id" as "companyId",')&&text.includes('cross join "business_unit"')];
      if(permitted[position-1]!==true)throw new Error('Unexpected borrowed stress statement at '+position);
      if(position!==4)return target.execute(statement);
      expect(compiled.params).toEqual(productBinds);
      const forwarded=candidateEpoch?statement:baseline;
      const started=performance.now(),rows=await target.execute(forwarded);
      captured.departmentMs=performance.now()-started;
      captured.forwarded=forwarded;captured.rows=rows;return rows;
     };
     const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
    }});
    metadata.activePair={epoch,label,stage:'ordinary'};persist();
    const started=performance.now(),{contextId:_contextId,...page}=await readEmployeeChoicesTx(guarded,ctx,input,signal),wallMs=performance.now()-started;
    const {forwarded,departmentMs}=captured;
    const entry:Observation={epoch,label,wallMs,departmentMs,total:page.total,statements:statements.length,rows:page.rows.length,dtoVerified:false,
     executed:candidateEpoch?'product-forwarded':'a293-first-witness-reference'};
    observations.push(entry);persist();
    expect(statements).toHaveLength(5);
    if(!forwarded||!captured.rows)throw new Error('Actual department statement was not forwarded');
    const seals=statements.map(({compiled})=>compiledSeal(compiled));
    if(epoch==='A0')productSeals[label]=seals;else expect(seals).toEqual(productSeals[label]);
    expect(forwarded).toBe(candidateEpoch?statements[3].query:baseline);
    expect(compiledSeal(dialect.sqlToQuery(forwarded))).toEqual(candidateEpoch?seals[3]:seal);
    expect(Array.from(captured.rows)).toEqual(proofRows);expect(page).toEqual(stressPage(b,scoped));
    entry.dtoVerified=true;
    metadata.activePair={epoch,label,stage:'explain'};persist();step(label+' native plan');
    const plan=await explain(tx,forwarded,epoch+'-'+label,!candidateEpoch,10,
     candidateEpoch?scoped.length:undefined,candidateEpoch?point:undefined);
    entry.explainMs=plan.executionMs;entry.sharedTraffic=plan.sharedTraffic;entry.pathRefusals=plan.pathRefusals;
    if(epoch==='A0')state.stress.push({label,wallMs,departmentMs,explainMs:plan.executionMs,total:page.total,statements:seals.length,rows:page.rows.length});
    delete metadata.activePair;persist();
   }
   step(epoch+' native prepared counters');
   const [row]=await tx.execute<{prepared:unknown[]}>(sql`select ${preparedFacetCounters} as prepared`);
   if(!Array.isArray(row?.prepared)||row.prepared.length>100)throw new Error('Native prepared counter bound exceeded');
   prepared[epoch]=row.prepared;persist();
  };

  state.phase='pair-observations';const stressDeadline=Math.min(stressEnd,performance.now()+18000);
  metadata.pairClock={caseEnd,stressDeadline,activeEnd,cleanupEnd:end};persist();
  await snapshot(stressDeadline,1000,async(tx,assertPhase)=>{
   const step=(deadline:number)=>(operation:string,ms=1000)=>{assertPhase();fit(deadline,ms+1000,operation);};
   const firstStep=step(stressDeadline),laterStep=step(activeEnd);
   firstStep('stress application metadata',500);
   const [identity]=await appWithLimit(tx,'1s');recordIdentity(identity,'500ms');expect(identity.bound).toBe('1s');
   expect(realm(identity)).toEqual(realm(ownerRealm));expect(identity.planner).toEqual(identities[0].planner);
   expect(identity.prepared?.length).toBeLessThanOrEqual(100);
   await stress(tx,'A0',firstStep);
   fit(stressDeadline,0,'initial stress evidence completion');
   for(const epoch of ['B0','B1','A1'] as const)await stress(tx,epoch,laterStep);
   for(const rows of [identity.prepared,...epochs.map(epoch=>prepared[epoch])]){
    expect(Array.isArray(rows)).toBe(true);
    for(const row of rows??[])expect([0,'0']).toContain((row as {generic_plans?:unknown}).generic_plans);
   }
   laterStep('final stress application identity');
   const [final]=await tx.execute<AppFacts>(appFacts);
   const {prepared:_prepared,bound:_bound,...initial}=identity;
   metadata.stressFinal=final;persist();
   expect(final).toEqual({...initial,statementTimeout:'1s'});
   fit(activeEnd,1000,'stress transaction finalization');
  },activeEnd);
  const afterStep=(operation:string)=>fit(activeEnd,1000,operation);
  await ownedBackend(afterStep);
  const after=await readFacetPlannerCatalogue(reservation,tenant,b.deptA,emptyIds,afterStep);
  const {relations,...other}=after;
  metadata.plannerAfter={relations,seals:Object.fromEntries(Object.entries(other).map(([key,value])=>[key,digest(JSON.stringify(value))]))};
  persist();expect(after).toEqual(before);pairStatus.catalogueUnchanged=true;
  const outcomes=profiles.map(label=>{
   const rows=epochs.map(epoch=>{
    const row=observations.find(value=>value.epoch===epoch&&value.label===label);
    if(!row?.dtoVerified||row.explainMs===undefined||row.sharedTraffic===undefined||!row.pathRefusals)
     throw new Error('Incomplete represented pair observation');
    return {...row,explainMs:row.explainMs,sharedTraffic:row.sharedTraffic,pathRefusals:row.pathRefusals};
   });
   const [a0,b0,b1,a1]=rows;
   const better=(key:'departmentMs'|'explainMs'|'sharedTraffic'|'wallMs')=>Math.max(b0[key],b1[key])<Math.min(a0[key],a1[key]);
   return {label,ordinary:better('departmentMs'),instrumented:better('explainMs'),traffic:better('sharedTraffic'),wholeRead:better('wallMs'),
    path:b0.pathRefusals.length===0&&b1.pathRefusals.length===0,
    stressLimits:rows.every(row=>row.wallMs<=6000&&row.departmentMs<=1250&&row.explainMs<=1000)};
  });
  metadata.pairOutcomes=outcomes;persist();
  fit(activeEnd,0,'represented pair evidence completion');
  pairStatus.complete=true;
  gate('sparseProductPairs',()=>{
   const expected={ordinary:true,instrumented:true,traffic:true,wholeRead:true,path:true,stressLimits:true};
   expect(outcomes).toEqual(profiles.map(label=>({label,...expected})));
  });
 }catch(error){workFailed=true;workError=error;}

 if(matchedObserved){
  gate('matched',()=>expect(state.matchedOutcome).not.toBe('refused'));
  if(gateStatus.matched==='pass'&&state.matchedOutcome==='equivalent-work')gateStatus.matched='equivalent-work';
 }
 if(state.stress.length===2)gate('sparseBaselineStress',()=>{
  for(const result of state.stress){
   expect(result.wallMs).toBeLessThanOrEqual(6000);expect(result.departmentMs).toBeLessThanOrEqual(1250);
   expect(result.explainMs).toBeLessThanOrEqual(1000);
  }
 });

 state.phase='settlement';
 const cleanupErrors:unknown[]=[];
 const {reservation,realm:ownerRealm}=fixture;
 if(reservation){
  if(fixture.transaction){
   const rollback={sent:false,acknowledged:false};metadata.rollback=rollback;
   try{
    fit(end,1000,'owned fixture rollback',true);rollback.sent=true;
    await reservation`rollback`;fixture.transaction=false;rollback.acknowledged=true;
   }catch(error){cleanupErrors.push(error);}
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
     expect(row).toMatchObject({state:'idle',outside:true});
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
 pairStatus.ownedStopRequired=state.unconfirmed;
 if(state.unconfirmed)allowPoolClose=false;
 state.complete=state.settled&&!workFailed&&!gateErrors.length&&state.plans.length===10&&pairStatus.complete&&pairStatus.catalogueUnchanged&&!signal.aborted;
 state.phase=state.complete?'complete':'failed';
 try{persist();}catch(error){cleanupErrors.push(error);}
 if(workFailed||gateErrors.length||cleanupErrors.length)
  throw new AggregateError([...(workFailed?[workError]:[]),...gateErrors,...cleanupErrors],'Native facet course or owned settlement refused');
 signal.throwIfAborted();expect(state.complete).toBe(true);
}
