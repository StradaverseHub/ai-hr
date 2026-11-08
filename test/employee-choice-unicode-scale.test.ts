/** Exact ECMAScript search must remain complete when every name is non-ASCII. */
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {availableParallelism,cpus,totalmem} from 'node:os';
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi,type TestContext} from 'vitest';
import {readEmployeeChoices} from '../core/employee-choice';
import {isEmployeeChoicePage} from '../lib/employee-choice';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {closeAll,migrateTestDb,owner} from './harness';
import {workerDb} from './db-names';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {pgSqlState} from '../lib/db-error';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
let ownedWork:Promise<void>|undefined,poisoned:Error|undefined;
beforeAll(migrateTestDb);afterAll(async()=>{await ownedWork?.catch(()=>{});await closeAll();});
it('measures exact full and missing searches over the real 50k Unicode population',(context:TestContext)=>{
 const wholeStarted=performance.now();let recordAbort=()=>{},abortReceiptError:unknown;
 const abort=()=>{poisoned=new Error('Facet case aborted; no new test-owned SQL may start');
  // Retain and drain already-admitted work. Never race its transaction with client.end().
  try{recordAbort();}catch(error){abortReceiptError=error;}
 };
 context.signal.addEventListener('abort',abort,{once:true});
 // Defer execution until its exact whole pending promise has been owned and its drain registered.
 const pending=Promise.resolve().then(async()=>{
 const assertActive=()=>{context.signal.throwIfAborted();if(poisoned)throw poisoned;};
 assertActive();expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;if(!pool)throw new Error('Canonical worker identity missing');
 const expectedDatabase=workerDb(pool);
 for(const [key,user]of [['DATABASE_URL','ai_hr_app'],['TEST_DATABASE_URL','ai_hr_app'],['TEST_MIGRATION_DATABASE_URL','postgres']] as const){
  let url:URL;try{url=new URL(process.env[key]!);}catch{throw new Error('Canonical worker URL is invalid');}
  if(url.hostname!=='127.0.0.1'||url.port!=='5433'||url.pathname!=='/'+expectedDatabase||url.username!==user||url.search!==''||url.hash!=='')throw new Error('Canonical disposable worker URL binding differs');
 }

 const report:Record<string,unknown>={kind:'NATIVE_UNICODE_EMPLOYEE_CHOICE_COMPONENT_ONLY',releaseEligible:false,employees:50000,namePrefix:'Fictional retained Personnel 人員 ',host:{node:process.version,logicalCpus:availableParallelism(),memoryBytes:totalmem(),cpuModels:[...new Set(cpus().map(cpu=>cpu.model))]}};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-choice-unicode-50k.json'),JSON.stringify(report,null,2));};
 recordAbort=()=>{report.caseAborted=true;report.ownerPoisoned=true;report.requiresExternalOwnedJobStop=true;report.complete=false;save();};
 const guardedSave=()=>{assertActive();save();};
 const {b,ctx,expectedFirst,expectedLast,organisationTagSample}=await seedPersonnelNativeFixture(50000,report,name=>{assertActive();report.phase=name;save();},guardedSave,'Fictional retained Personnel 人員 ');
 report.fixtureReady=true;save();
 const statements:Record<string,unknown>[]=[],timings:Record<string,number>={};report.statements=statements;report.timings=timings;
 const actual=database.withTenant,dialect=new PgDialect();
 const digest=(text:string)=>createHash('sha256').update(text).digest('hex'),facetSqlSha='95900f68e826391eea261670dbeff344a7ef75e2ba921090ceef1ed949de172e';
 let facetQuery:SQL|undefined,facetParameterSeal='',originalFacetRows:unknown,capturedFacets=0;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  assertActive();await tx.execute(sql`set local lock_timeout='300ms'`);assertActive();await tx.execute(sql`set local statement_timeout='20s'`);
  return read(new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(query:SQL)=>{
    assertActive();
    const entry:Record<string,unknown>={sql:dialect.sqlToQuery(query).sql},started=performance.now();statements.push(entry);save();
    try{const prepared=dialect.sqlToQuery(query),result=await target.execute(query);
     if(digest(prepared.sql)===facetSqlSha){const seal=JSON.stringify(prepared.params);expect(prepared.params).toHaveLength(6);
      if(facetQuery){expect(seal).toBe(facetParameterSeal);expect(Array.from(result)).toEqual(originalFacetRows);}
      else{facetQuery=query;facetParameterSeal=seal;originalFacetRows=Array.from(result);}capturedFacets++;
     }return result;}catch(error){entry.error=String(error);throw error;}finally{entry.ms=performance.now()-started;save();}
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }}));
 },options));
 async function probeDepartmentFacet(){
  assertActive();expect(capturedFacets).toBe(4);expect(facetQuery).toBeDefined();
  expect(statements).toHaveLength(305);
  const query=facetQuery;if(!query)throw new Error('Actual department SQL object was not captured');
  expect(originalFacetRows).toEqual([{companyId:b.companyId,company:'Acme Sdn Bhd',departmentId:b.deptA,departmentCode:null,department:'Finance',businessUnitId:null,businessUnitCode:null,businessUnit:null}]);
  const probeStart=performance.now(),probeDeadline=probeStart+60000,wholeDeadline=wholeStarted+300000;
  if(wholeDeadline-probeStart<65000)throw new Error('Insufficient original case lifetime for the fixed facet probe and final drain');
  const state={complete:false,transactionSettled:false,indexRestored:false,observerReleased:false,poisoned:false,
   phases:[] as string[],plans:[] as Record<string,unknown>[],rowChecks:0,comparisonEligible:false,
   instrumentation:'EXPLAIN ANALYZE BUFFERS TIMING OFF; not product/native-node-self-time or browser latency',
   sourceSqlSha256:facetSqlSha,parameterCount:6,probeBudgetMs:60000,cleanupReserveMs:10000};
  report.facetExperiment=state;const earlierAbortRecord=recordAbort;recordAbort=()=>{state.complete=false;state.poisoned=true;earlierAbortRecord();};save();
  const privateFacts:Record<string,unknown>={kind:'FICTIONAL_PRIVATE_FACET_PLANS_AND_NATIVE_CATALOGUE',plans:[],catalogues:[]};
  const rawPlans:unknown[]=[],catalogues:unknown[]=[];let rawPlanPayloadBytes=0;privateFacts.plans=rawPlans;privateFacts.catalogues=catalogues;
  const saveProbe=()=>{
   const {plans:_plans,...metadata}=privateFacts;
   if(Buffer.byteLength(JSON.stringify(metadata))>65536)throw new Error('Aggregate complete native metadata exceeds64KiB');
   if(rawPlanPayloadBytes>4*1024*1024)throw new Error('Aggregate raw plans exceed4MiB');
   if(process.env.AIHR_FOCUSED_EVIDENCE_DIR){
    const bytes=JSON.stringify(privateFacts);if(Buffer.byteLength(bytes)>4*1024*1024+65536+1024)throw new Error('Private facet payload plus fixed framing exceeds its byte bound');
    writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-choice-department-facet-private.json'),bytes,{mode:0o600});
   }
   save();
  };
  const recordCatalogue=(label:string,facts:unknown)=>{const entry={label,facts},{plans:_plans,...metadata}=privateFacts,bytes=Buffer.byteLength(JSON.stringify({...metadata,catalogues:[...catalogues,entry]}));
   if(bytes>65536){privateFacts.catalogueOverflowBytes=bytes;saveProbe();throw new Error('Aggregate complete native metadata exceeds64KiB');}catalogues.push(entry);
  };
  const step=(ms:number,label:string,cleanup=false)=>{
   assertActive();const reserve=cleanup?0:10000;
   if(performance.now()+ms+reserve>Math.min(probeDeadline,wholeDeadline-5000))throw new Error('Facet probe cannot admit complete '+label+' slot');
  };
  const phase=(name:string)=>{state.phases.push(name);saveProbe();};
  type IndexFact={oid:string;name:string;owner:string;method:string;columns:(string|null)[];predicate:string|null;expressions:string|null;
   definition:string;valid:boolean;ready:boolean;live:boolean;unique:boolean;exclusion:boolean;immediate:boolean;
   checkXmin:boolean;replicaIdentity:boolean;nullsNotDistinct:boolean;keyCount:number;attributeCount:number;
   opclasses:string;collations:string;options:string;tablespace:string;reloptions:string[]|null;acl:string|null};
  type Identity={role:string;login:string;database:string;databaseOid:string;address:string|null;port:number|null;pid:number;
   version:string;superuser:boolean;bypass:boolean;readOnly:boolean};
  type AppIdentity=Identity&{backendStart:string;tenant:string;user:string;isolation:string;readOnly:boolean;employmentRls:boolean;assignmentRls:boolean;personRls:boolean;
   jit:string;workMem:string;hashMultiplier:string;parallelWorkers:string;seqscan:string;planCache:string;searchPath:string;
   lockTimeout:string;statementTimeout:string;collate:string;ctype:string;icu:string|null;collationVersion:string|null};
  const fixedIndex='employee_choice_department_probe_20261109',appPids=new Set<number>(),ddlPids=new Set<number>(),backendStarts=new Map<number,string>();
  const ownBackend=(pid:number,start:string)=>{expect(Number.isSafeInteger(pid)&&pid>0).toBe(true);expect(start).toMatch(/^\d+(?:\.\d+)?$/);if(backendStarts.has(pid))expect(backendStarts.get(pid)).toBe(start);else backendStarts.set(pid,start);};
  let created:IndexFact|undefined,createStarted=false,createCommitObserved=false,dropAttempted=false,dropCommitObserved=false;
  let originalError:unknown,failed=false,dropExecuted=false;const cleanupErrors:unknown[]=[];
  expect(owner.client.options.max).toBe(10);expect(owner.client.options.connect_timeout).toBeLessThanOrEqual(30);
  step(30000,'existing owner connection reservation');const observer=await owner.client.reserve();
  let observerTransaction=false,observerRolledBack=false,pidsSettled=false;
  let ownerIdentity:Identity|undefined,firstApp:Omit<AppIdentity,'pid'|'backendStart'>|undefined;
  const catalogue=async(cleanup=false)=>{
   const boundOwner=ownerIdentity;if(!boundOwner)throw new Error('Catalogue requires confirmed owned realm');
   step(5000,'catalogue transaction',cleanup);
   return owner.client.begin('read only',async tx=>{
    step(5000,'catalogue limits',cleanup);await tx`select set_config('statement_timeout','5s',true),set_config('lock_timeout','300ms',true)`;
    step(5000,'Assignment index catalogue',cleanup);
    const indexes=Array.from(await tx<IndexFact[]>`select i.indexrelid::text as oid,c.relname as name,c.relowner::regrole::text as owner,am.amname as method,
     array(select a.attname from unnest(i.indkey) with ordinality k(attnum,n) left join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum order by k.n) as columns,
     pg_get_expr(i.indpred,i.indrelid) as predicate,pg_get_expr(i.indexprs,i.indrelid) as expressions,pg_get_indexdef(i.indexrelid) as definition,
     i.indisvalid as valid,i.indisready as ready,i.indislive as live,i.indisunique as unique,i.indisexclusion as exclusion,i.indimmediate as immediate,
     i.indcheckxmin as "checkXmin",i.indisreplident as "replicaIdentity",i.indnullsnotdistinct as "nullsNotDistinct",i.indnkeyatts::int as "keyCount",i.indnatts::int as "attributeCount",
     i.indclass::text as opclasses,i.indcollation::text as collations,i.indoption::text as options,c.reltablespace::text as tablespace,c.reloptions,c.relacl::text as acl
     from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam where i.indrelid='public.assignment'::regclass order by c.relname limit 101`);
    expect(indexes.length).toBeLessThanOrEqual(100);if(Buffer.byteLength(JSON.stringify(indexes))>65536)throw new Error('Assignment catalogue byte bound exceeded');
    step(5000,'table facts',cleanup);
    const [table]=await tx`select pg_backend_pid() as "backendPid",(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart",c.oid::text as oid,c.relowner::regrole::text as owner,c.relkind as kind,c.relpersistence as persistence,c.relrowsecurity as rls,c.relforcerowsecurity as force_rls,c.relacl::text as acl,
     c.reltuples,c.relpages,c.relallvisible,c.relhasindex,to_regclass('public.employee_choice_department_probe_20261109')::text as probe_name,
     s.last_analyze::text,s.last_autoanalyze::text from pg_class c left join pg_stat_all_tables s on s.relid=c.oid where c.oid='public.assignment'::regclass`;
    expect(table.backendPid).not.toBe(boundOwner.pid);ownBackend(table.backendPid,table.backendStart);ddlPids.add(table.backendPid);
    step(5000,'RLS policy catalogue',cleanup);
    const policies=Array.from(await tx`select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='assignment' order by policyname limit 101`);
    expect(policies.length).toBeLessThanOrEqual(100);
    step(5000,'fixture population facts',cleanup);
    const [population]=await tx`select (select count(*)::int from public.employment where tenant_id=${b.tenantId}::uuid) as employees,
     (select count(*)::int from public.person where tenant_id=${b.tenantId}::uuid) as people,
     (select count(*)::int from public.assignment where tenant_id=${b.tenantId}::uuid) as assignments,
     (select count(*)::int from public.assignment where tenant_id=${b.tenantId}::uuid and department_id=${b.deptA}::uuid) as finance,
     (select count(*)::int from public.assignment where tenant_id=${b.tenantId}::uuid and department_id=${b.deptB}::uuid) as operations`;
    expect(population).toEqual({employees:50000,people:50000,assignments:50000,finance:50000,operations:0});
    return {indexes,table,policies,population};
   });
  };
  const checkIndex=(row:IndexFact)=>{
   expect(row).toMatchObject({name:fixedIndex,owner:ownerIdentity?.role,method:'btree',columns:['tenant_id','department_id','employment_id'],valid:true,ready:true,live:true,unique:false,exclusion:false,expressions:null});
   expect(row.predicate?.replace(/\s+/g,'').toLowerCase()).toBe('((valid_toisnull)and(superseded_atisnull))');
  };
  const createIndex=async()=>{
   phase('CREATE');createStarted=true;step(20000,'CREATE transaction');
   await owner.client.begin(async tx=>{
    step(5000,'CREATE limits');await tx`select set_config('statement_timeout','20s',true),set_config('lock_timeout','300ms',true)`;
    step(5000,'CREATE backend identity');const [pid]=await tx<{pid:number;backendStart:string}[]>`select pg_backend_pid() as pid,(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart"`;expect(pid.pid).not.toBe(ownerIdentity?.pid);ownBackend(pid.pid,pid.backendStart);ddlPids.add(pid.pid);
    step(20000,'CREATE INDEX');await tx`create index employee_choice_department_probe_20261109 on public.assignment(tenant_id,department_id,employment_id) where valid_to is null and superseded_at is null`;
    step(5000,'created index identity');const rows=Array.from(await tx<IndexFact[]>`select i.indexrelid::text as oid,c.relname as name,c.relowner::regrole::text as owner,am.amname as method,
     array(select a.attname from unnest(i.indkey) with ordinality k(attnum,n) left join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum order by k.n) as columns,
     pg_get_expr(i.indpred,i.indrelid) as predicate,pg_get_expr(i.indexprs,i.indrelid) as expressions,pg_get_indexdef(i.indexrelid) as definition,
     i.indisvalid as valid,i.indisready as ready,i.indislive as live,i.indisunique as unique,i.indisexclusion as exclusion,i.indimmediate as immediate,
     i.indcheckxmin as "checkXmin",i.indisreplident as "replicaIdentity",i.indnullsnotdistinct as "nullsNotDistinct",i.indnkeyatts::int as "keyCount",i.indnatts::int as "attributeCount",
     i.indclass::text as opclasses,i.indcollation::text as collations,i.indoption::text as options,c.reltablespace::text as tablespace,c.reloptions,c.relacl::text as acl
     from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam where i.indrelid='public.assignment'::regclass and c.relname='employee_choice_department_probe_20261109'`);
    expect(rows).toHaveLength(1);created=rows[0];checkIndex(created);privateFacts.createdIndex=created;saveProbe();
   });
   createCommitObserved=true;privateFacts.createCommitObserved=true;saveProbe();
  };
  const dropIndex=async(cleanup:boolean)=>{
   if(dropAttempted)return;step(5000,'owned DROP transaction',cleanup);dropAttempted=true;
   await owner.client.begin(async tx=>{
    step(5000,'DROP limits',cleanup);await tx`select set_config('statement_timeout','5s',true),set_config('lock_timeout','300ms',true)`;
    step(5000,'DROP backend identity',cleanup);const [pid]=await tx<{pid:number;backendStart:string}[]>`select pg_backend_pid() as pid,(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart"`;expect(pid.pid).not.toBe(ownerIdentity?.pid);ownBackend(pid.pid,pid.backendStart);ddlPids.add(pid.pid);
    step(5000,'owned index identity',cleanup);const rows=await tx<{oid:string;definition:string;owner:string}[]>`select c.oid::text as oid,pg_get_indexdef(c.oid) as definition,c.relowner::regrole::text as owner
     from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='employee_choice_department_probe_20261109' and c.relkind='i'`;
    if(rows.length===0){privateFacts.createdAbsentOnRecovery=true;if(createCommitObserved)throw new Error('Committed owned index unexpectedly disappeared');return;}
    expect(created).toBeDefined();if(!created)throw new Error('Unknown index identity: DROP refused');
    expect(Array.from(rows)).toEqual([{oid:created.oid,definition:created.definition,owner:created.owner}]);
    step(5000,'DROP INDEX',cleanup);await tx`drop index public.employee_choice_department_probe_20261109`;dropExecuted=true;
   });
   dropCommitObserved=dropExecuted;privateFacts.dropCommitObserved=dropCommitObserved;saveProbe();
  };
  const planSummary=(raw:unknown)=>{
   if(!Array.isArray(raw)||raw.length!==1||!raw[0]||typeof raw[0]!=='object')throw new Error('Unexpected native EXPLAIN envelope');
   const doc=raw[0] as Record<string,unknown>;if(!doc.Plan||typeof doc.Plan!=='object'||Array.isArray(doc.Plan))throw new Error('Missing native Plan');
   if(Buffer.byteLength(JSON.stringify(doc))>1024*1024)throw new Error('Native plan exceeds its fixed byte bound');
   const numeric=(node:Record<string,unknown>,key:string,optional=false)=>{const value=node[key];if(value===undefined&&optional)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('Native plan counter unavailable');return value;};
   const nodeTypes=new Set(['Result','ProjectSet','ModifyTable','Append','Merge Append','Recursive Union','BitmapAnd','BitmapOr','Seq Scan','Sample Scan','Gather','Gather Merge','Index Scan','Index Only Scan','Bitmap Index Scan','Bitmap Heap Scan','Tid Scan','Tid Range Scan','Subquery Scan','Function Scan','Table Function Scan','Values Scan','CTE Scan','Named Tuplestore Scan','WorkTable Scan','Foreign Scan','Custom Scan','Nested Loop','Merge Join','Hash Join','Materialize','Memoize','Sort','Incremental Sort','Group','Aggregate','WindowAgg','Unique','SetOp','LockRows','Limit','Hash']);
   const stack=[{node:doc.Plan as Record<string,unknown>,depth:0}],assignments:Record<string,unknown>[]=[];let nodes=0,usesProbe=false;
   while(stack.length){const {node,depth}=stack.pop()!;if(++nodes>2048||depth>64)throw new Error('Native plan structural bound exceeded');
    if(node['Index Name']===fixedIndex)usesProbe=true;
    if(typeof node['Node Type']!=='string'||!nodeTypes.has(node['Node Type']))throw new Error('Native node type unavailable');
    if(node['Relation Name']==='assignment')assignments.push({nodeType:node['Node Type'],actualRows:numeric(node,'Actual Rows'),loops:numeric(node,'Actual Loops'),sharedHitBlocks:numeric(node,'Shared Hit Blocks',true),sharedReadBlocks:numeric(node,'Shared Read Blocks',true),tempReadBlocks:numeric(node,'Temp Read Blocks',true),tempWrittenBlocks:numeric(node,'Temp Written Blocks',true)});
    if(node.Plans!==undefined){if(!Array.isArray(node.Plans))throw new Error('Unexpected native child plans');for(const child of node.Plans){if(!child||typeof child!=='object')throw new Error('Unexpected native plan node');stack.push({node:child,depth:depth+1});}}
   }
   for(const key of ['Planning Time','Execution Time'])if(typeof doc[key]!=='number'||!Number.isFinite(doc[key])||doc[key]<0)throw new Error('Native plan timing missing');
   return {planningMs:doc['Planning Time'],executionMs:doc['Execution Time'],nodes,usesProbe,assignmentNodes:assignments};
  };
  const appRead=async(label:string,explain:boolean)=>{
   phase(label);step(20000,label+' transaction');const started=performance.now();
   const result=await actual(ctx,async tx=>{
    step(5000,label+' limits');await tx.execute(sql`select set_config('lock_timeout','300ms',true),set_config('statement_timeout','20s',true)`);
    step(20000,label+' native principal');await assertAiPresentationPrincipalTx(tx,ctx);
    step(5000,label+' identity');const [identity]=await tx.execute<AppIdentity>(sql`select current_user as role,session_user as login,current_database() as database,
     d.oid::text as "databaseOid",inet_server_addr()::text as address,inet_server_port() as port,pg_backend_pid() as pid,(select extract(epoch from backend_start)::text from pg_stat_activity where pid=pg_backend_pid()) as "backendStart",current_setting('server_version_num') as version,r.rolsuper as superuser,r.rolbypassrls as bypass,
     app.current_tenant_id()::text as tenant,app.current_user_id()::text as "user",current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only')='on' as "readOnly",
     row_security_active('public.employment') as "employmentRls",row_security_active('public.assignment') as "assignmentRls",row_security_active('public.person') as "personRls",
     current_setting('jit') as jit,current_setting('work_mem') as "workMem",current_setting('hash_mem_multiplier') as "hashMultiplier",current_setting('max_parallel_workers_per_gather') as "parallelWorkers",
     current_setting('enable_seqscan') as seqscan,current_setting('plan_cache_mode') as "planCache",current_setting('search_path') as "searchPath",current_setting('lock_timeout') as "lockTimeout",current_setting('statement_timeout') as "statementTimeout",
     d.datcollate as collate,d.datctype as ctype,d.daticulocale as icu,d.datcollversion as "collationVersion" from pg_database d join pg_roles r on r.rolname=current_user where d.datname=current_database()`);
    expect(identity).toMatchObject({role:'ai_hr_app',login:'ai_hr_app',superuser:false,bypass:false,tenant:ctx.tenantId,user:ctx.userId,isolation:'repeatable read',readOnly:true,employmentRls:true,assignmentRls:true,personRls:true,lockTimeout:'300ms',statementTimeout:'20s'});
    if(!ownerIdentity)throw new Error('Missing owned worker realm');for(const field of ['database','databaseOid','address','port','version'] as const)expect(identity[field]).toBe(ownerIdentity[field]);
    const {pid,backendStart,...stableIdentity}=identity;ownBackend(pid,backendStart);appPids.add(pid);privateFacts.appIdentities??=[];(privateFacts.appIdentities as unknown[]).push({label,...identity});if(firstApp)expect(stableIdentity).toEqual(firstApp);else firstApp=stableIdentity;
    const prepared=dialect.sqlToQuery(query);expect(digest(prepared.sql)).toBe(facetSqlSha);expect(JSON.stringify(prepared.params)).toBe(facetParameterSeal);
    step(20000,label+' exact captured statement');return explain?await tx.execute<{"QUERY PLAN":unknown}>(sql`explain(analyze,buffers,verbose,settings,timing off,format json) ${query}`):await tx.execute(query);
   },{readOnlySnapshot:true,readSignal:context.signal});
   assertActive();
   if(explain){expect(result).toHaveLength(1);const raw=(result[0] as Record<string,unknown>)['QUERY PLAN'],bytes=Buffer.byteLength(JSON.stringify(raw));
    if(bytes>1024*1024||rawPlans.length>=4||rawPlanPayloadBytes+bytes>4*1024*1024){privateFacts.planOverflowBytes=bytes;saveProbe();throw new Error('Native raw plan payload bound exceeded');}
    const summary=planSummary(raw);rawPlanPayloadBytes+=bytes;privateFacts.rawPlanPayloadBytes=rawPlanPayloadBytes;rawPlans.push({label,raw});state.plans.push({label,wallMs:performance.now()-started,...summary});}
   else{expect(Array.from(result)).toEqual([{companyId:b.companyId,company:'Acme Sdn Bhd',departmentId:b.deptA,departmentCode:null,department:'Finance',businessUnitId:null,businessUnitCode:null,businessUnit:null}]);state.rowChecks++;}
   saveProbe();
  };
  let before:Awaited<ReturnType<typeof catalogue>>|undefined,restored:Awaited<ReturnType<typeof catalogue>>|undefined;
  try{
   phase('NATIVE_REALM');step(5000,'observer read-only BEGIN');await observer`begin read only`;observerTransaction=true;
   step(5000,'observer local bounds');await observer`select set_config('statement_timeout','5s',true),set_config('lock_timeout','300ms',true)`;
   step(5000,'owner realm');const [identity]=await observer<Identity[]>`select current_user as role,session_user as login,current_database() as database,d.oid::text as "databaseOid",
    inet_server_addr()::text as address,inet_server_port() as port,pg_backend_pid() as pid,current_setting('server_version_num') as version,r.rolsuper as superuser,r.rolbypassrls as bypass,current_setting('transaction_read_only')='on' as "readOnly" from pg_database d join pg_roles r on r.rolname=current_user where d.datname=current_database()`;
   ownerIdentity=identity;expect(identity).toMatchObject({role:'postgres',login:'postgres',database:expectedDatabase,readOnly:true});expect(identity.version.startsWith('16')).toBe(true);privateFacts.ownerIdentity=identity;
   step(5000,'owned cluster identity');privateFacts.cluster=Array.from(await observer`select system_identifier::text from pg_control_system()`);
   before=await catalogue();recordCatalogue('OLD',before);expect(before.table.probe_name).toBeNull();expect(before.table).toMatchObject({owner:identity.role,kind:'r',persistence:'p'});
   expect(before.indexes.some(row=>row.valid&&row.ready&&row.live&&(row.columns[0]==='department_id'||row.columns[0]==='tenant_id'&&row.columns[1]==='department_id'))).toBe(false);saveProbe();
   await appRead('OLD_PLAN',true);await appRead('OLD_ROWS',false);
   await createIndex();const indexed=await catalogue();recordCatalogue('INDEX',indexed);expect(indexed.indexes.filter(row=>row.name!==fixedIndex)).toEqual(before.indexes);expect(indexed.policies).toEqual(before.policies);expect(indexed.population).toEqual(before.population);expect(indexed.indexes.filter(row=>row.name===fixedIndex)).toHaveLength(1);checkIndex(indexed.indexes.find(row=>row.name===fixedIndex)!);saveProbe();
   await appRead('INDEX_PLAN_1',true);await appRead('INDEX_ROWS',false);await appRead('INDEX_PLAN_2',true);
   await dropIndex(false);restored=await catalogue();recordCatalogue('RESTORED',restored);expect(restored.indexes).toEqual(before.indexes);expect(restored.table.probe_name).toBeNull();expect(restored.policies).toEqual(before.policies);expect(restored.population).toEqual(before.population);
   for(const key of ['oid','owner','kind','persistence','rls','force_rls','acl'])expect(restored.table[key]).toEqual(before.table[key]);
   state.indexRestored=true;await appRead('RESTORED_OLD_PLAN',true);await appRead('RESTORED_OLD_ROWS',false);
   expect(state.plans.map(row=>row.label)).toEqual(['OLD_PLAN','INDEX_PLAN_1','INDEX_PLAN_2','RESTORED_OLD_PLAN']);expect(state.rowChecks).toBe(3);
   state.comparisonEligible=['reltuples','relpages','relallvisible','last_analyze','last_autoanalyze'].every(key=>before!.table[key]===indexed.table[key]&&before!.table[key]===restored!.table[key]);privateFacts.tableEstimatesUnchanged=state.comparisonEligible;
  }catch(error){failed=true;originalError=error;privateFacts.originalFailure={name:error instanceof Error?error.name:typeof error,sqlState:pgSqlState(error)};try{saveProbe();}catch(evidenceError){cleanupErrors.push(evidenceError);}}
  finally{
   if(context.signal.aborted||poisoned||!ownerIdentity||!before){state.poisoned=true;privateFacts.cleanup='UNCONFIRMED_OR_ABORTED_NO_FURTHER_DATA_SQL_REQUIRES_OWNED_JOB_STOP';}
   else{
    try{
     if(created&&!dropAttempted)await dropIndex(true);
     if(!state.indexRestored){const after=await catalogue(true);recordCatalogue('FINAL_CLEANUP',after);if(before){expect(after.indexes).toEqual(before.indexes);expect(after.policies).toEqual(before.policies);expect(after.population).toEqual(before.population);}expect(after.table.probe_name).toBeNull();state.indexRestored=true;}
     step(5000,'settled native PIDs',true);const pids=[...new Set([...appPids,...ddlPids])];expect(pids).not.toContain(ownerIdentity?.pid);
     // This is the reserved observer's FIRST pg_stat_activity read: no earlier transaction activity snapshot is reused.
     const settled=Array.from(await observer<{pid:number;backendStart:string;state:string;outsideTransaction:boolean}[]>`select pid,extract(epoch from backend_start)::text as "backendStart",state,xact_start is null as "outsideTransaction" from pg_stat_activity where datid=${ownerIdentity!.databaseOid}::oid and pid=any(${pids}::int[])`);
     const witnesses=pids.map(pid=>{const expectedStart=backendStarts.get(pid);expect(expectedStart).toBeDefined();const row=settled.find(row=>row.pid===pid);
      if(!row)return {pid,expectedStart,outcome:'ORIGINAL_BACKEND_ABSENT_CLOSED'};
      if(row.backendStart!==expectedStart)return {pid,expectedStart,outcome:'ORIGINAL_BACKEND_CLOSED_PID_REUSED',observedStart:row.backendStart};
      expect(row).toMatchObject({state:'idle',outsideTransaction:true});return {pid,expectedStart,outcome:'MATCHED_BACKEND_IDLE_OUTSIDE_TRANSACTION'};
     });expect(witnesses).toHaveLength(pids.length);privateFacts.settledPids=witnesses;pidsSettled=true;
    }catch(error){cleanupErrors.push(error);privateFacts.cleanupFailure={name:error instanceof Error?error.name:typeof error,sqlState:pgSqlState(error)};}
   }
   if(observerTransaction&&!context.signal.aborted&&!poisoned){try{step(5000,'observer ROLLBACK',true);await observer`rollback`;observerTransaction=false;observerRolledBack=true;}catch(error){cleanupErrors.push(error);}}
   state.transactionSettled=pidsSettled&&observerRolledBack;
   if(!observerTransaction){try{observer.release();state.observerReleased=true;}catch(error){cleanupErrors.push(error);}}
   else{privateFacts.observerReservation='RETAINED_UNCONFIRMED_TRANSACTION_FOR_QUIESCENT_TEARDOWN_OR_OWNED_JOB_STOP';}
   if(!state.indexRestored||!state.transactionSettled||!state.observerReleased){state.poisoned=true;poisoned??=new Error('Facet ownership uncertain; requires external owned job stop');privateFacts.requiresExternalOwnedJobStop=true;report.ownerPoisoned=true;report.requiresExternalOwnedJobStop=true;}
   privateFacts.observer={readOnlyRollbackObserved:observerRolledBack,released:state.observerReleased};
   privateFacts.ddl={createStarted,createdOid:created?.oid??null,createCommitObserved,dropAttempted,dropExecuted,dropCommitObserved};
   state.complete=!failed&&!context.signal.aborted&&!poisoned&&cleanupErrors.length===0&&state.indexRestored&&state.transactionSettled&&state.observerReleased&&state.plans.length===4&&state.rowChecks===3;
   try{saveProbe();}catch(error){cleanupErrors.push(error);state.complete=false;}
  }
  if(failed||cleanupErrors.length)throw new AggregateError([...(failed?[originalError]:[]),...cleanupErrors],'Exact facet probe or owned cleanup did not complete');
  expect(state.complete).toBe(true);
 }
 let caseFailure:unknown,caseFailed=false;
 try{
  assertActive();let started=performance.now();const first=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'人員',selectedId:expectedLast.at(-1)});timings.firstMs=performance.now()-started;
  expect(isEmployeeChoicePage(JSON.parse(JSON.stringify(first)))).toBe(true);expect(first.total).toBe(50000);expect(first.rows.map(row=>row.employmentId)).toEqual(expectedFirst);expect(first.selected?.employmentId).toBe(expectedLast.at(-1));expect(first.rows.every(row=>row.name.includes('人員'))).toBe(true);
  assertActive();started=performance.now();const deep=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'人員',offset:49975});timings.deepMs=performance.now()-started;
  expect(deep.total).toBe(50000);expect(deep.rows.map(row=>row.employmentId)).toEqual(expectedLast);
  assertActive();started=performance.now();const missing=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'absent-unicode-choice',selectedId:expectedLast.at(-1)});timings.missingMs=performance.now()-started;
  expect(missing.total).toBe(0);expect(missing.rows).toEqual([]);expect(missing.selected?.employmentId).toBe(expectedLast.at(-1));
  assertActive();started=performance.now();const filtered=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'人員',departmentId:b.deptA,status:'active',selectedId:expectedLast.at(-1)});timings.organisationFilteredMs=performance.now()-started;
  expect(isEmployeeChoicePage(JSON.parse(JSON.stringify(filtered)))).toBe(true);expect(filtered.total).toBe(40000);expect(filtered.rows.map(row=>row.employmentId)).toEqual(organisationTagSample.filter((_,index)=>(index+1)%5!==0).slice(0,25));expect(filtered.selected?.employmentId).toBe(expectedLast.at(-1));
  report.maxPageRows=Math.max(first.rows.length,deep.rows.length,missing.rows.length,filtered.rows.length);report.exactNativeIdsAndCounts=true;save();
  await probeDepartmentFacet();
 }catch(error){caseFailure=error;caseFailed=true;throw error;}finally{spy.mockRestore();try{save();}catch(error){throw new AggregateError([...(caseFailed?[caseFailure]:[]),error],'Native case and final receipt failure');}}
 });
 ownedWork=pending;
 context.onTestFinished(async()=>{try{await pending.catch(()=>{});if(abortReceiptError!==undefined)throw new AggregateError([abortReceiptError],'Abort receipt persistence failed');}finally{context.signal.removeEventListener('abort',abort);ownedWork=undefined;}});
 if(context.signal.aborted)abort();
 return pending;
},300000);
