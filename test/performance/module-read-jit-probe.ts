/** Closed disposable test owner. No product hook, SQL rewrite, authority or JIT policy. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {vi} from 'vitest';
import * as database from '../../db/client';
import type {SessionContext,Tx} from '../../db/client';
import {withModulePresentationRead} from '../../core/module-presentation-read';
import {assertAiPresentationPrincipalTx} from '../../core/ai-principal';
import {owner} from '../harness';
import {workerDb} from '../db-names';

export type JitMode='on'|'off';
export type CapturedStatement={statement:SQL;text:string;params:unknown[];digest:string;classification:string;ordinal:number;rows:number|null;elapsedMs:number;succeeded:boolean};
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesDigest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const settingSql=`select pg_backend_pid()as pid,current_user as role,session_user as login,
 current_setting('jit')as jit,pg_jit_available()as available,current_setting('server_version_num')as version,
 current_setting('jit_above_cost')as above,current_setting('jit_inline_above_cost')as inline,
 current_setting('jit_optimize_above_cost')as optimize,current_setting('work_mem')as work,
 current_setting('hash_mem_multiplier')as hash,current_setting('plan_cache_mode')as cache,
 current_setting('statement_timeout')as statement,current_setting('lock_timeout')as "lock",
 current_setting('row_security')as rls`;
export function classifyNativeStatement(text:string){
 const q=text.toLowerCase().replace(/\s+/g,' ');
 if(q.includes('public.app_user u'))return 'principal';
 if(q.includes('attendance_month_population'))return 'attendance-population';
 if(q.includes('from \"attendance\"'))return 'attendance-days';
 if(q.includes('analytics_master_count'))return 'master-count';
 if(q.includes('\"gender\"')&&q.includes('\"date_of_birth\"'))return 'demographic-dimensions';
 if(q.startsWith('select \"employee_statutory_my\".\"epf_citizenship\", count(distinct \"person\".\"id\")')&&q.endsWith('group by \"employee_statutory_my\".\"epf_citizenship\"'))return 'nationality';
 if(q.startsWith('fetch forward 512 from analytics_carry_identities'))return 'carry-identities-fetch';
 return 'unclassified';
}
type Settings={pid:number;role:string;login:string;jit:string;available:boolean;version:string;above:string;inline:string;optimize:string;work:string;hash:string;cache:string;statement:string;lock:string;rls:string};

/** One bounded fixture-only maintenance command; never a paired app setting. */
export async function maintainModuleReadFixture(report:Record<string,unknown>,save:()=>void){
 const maintenance:Record<string,unknown>={kind:'WHOLE_OWNED_WORKER_VACUUM_ANALYZE',status:'reserving',complete:false,
  statementLimitMs:45000,lockLimitMs:5000,newPools:0,reservedOwnerConnections:1,retries:0};
 report.fixtureMaintenance=maintenance;save();
 const connection=await owner.client.reserve();
 let defaults:Settings|undefined,primary:unknown,failed=false,restored=false;
 const settings=async()=>{const [row]=await connection.unsafe(settingSql,[],{prepare:false});return row as unknown as Settings;};
 try{
  defaults=await settings();const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;assert(pool&&/^[1-9][0-9]*$/.test(pool));
  const [native]=await connection`select current_database()as database,pg_backend_pid()as pid,
   current_setting('autovacuum')as autovacuum,current_setting('track_counts')as "trackCounts",
   current_setting('autovacuum_naptime')as "naptime",current_setting('autovacuum_max_workers')as "maxWorkers",
   current_setting('autovacuum_vacuum_threshold')as "vacuumThreshold",current_setting('autovacuum_vacuum_scale_factor')as "vacuumScale",
   current_setting('autovacuum_vacuum_insert_threshold')as "insertThreshold",current_setting('autovacuum_vacuum_insert_scale_factor')as "insertScale",
   current_setting('autovacuum_analyze_threshold')as "analyzeThreshold",current_setting('autovacuum_analyze_scale_factor')as "analyzeScale"`;
  assert.equal(native.database,workerDb(pool));assert.equal(native.pid,defaults.pid);assert.equal(defaults.role,'postgres');assert.equal(defaults.login,'postgres');
  assert.equal(native.autovacuum,'on');assert.equal(native.trackCounts,'on');maintenance.native=native;maintenance.defaults=defaults;
  await connection`select set_config('statement_timeout','45s',false),set_config('lock_timeout','5s',false)`;
  const [bounds]=await connection`select pg_backend_pid()as pid,(select setting::integer from pg_settings where name='statement_timeout')as "statementMs",(select setting::integer from pg_settings where name='lock_timeout')as "lockMs"`;
  assert.deepEqual(bounds,{pid:defaults.pid,statementMs:45000,lockMs:5000});maintenance.actualBounds=bounds;
  maintenance.status='started';maintenance.startedAtMs=Date.now();save();const start=performance.now();
  try{await connection.unsafe('vacuum(analyze)',[],{prepare:false});maintenance.status='completed';maintenance.commandCompleted=true;}
  finally{maintenance.endedAtMs=Date.now();maintenance.elapsedMs=performance.now()-start;}
 }catch(error){failed=true;primary=error;maintenance.status='refused';}
 finally{
  // VACUUM is top-level/autocommit. Every native command above has settled before
  // session restoration; no aborted transaction is queried or carrier reused.
  try{
   assert(defaults,'Maintenance default custody unavailable');
   await connection`select set_config('statement_timeout',${defaults.statement},false),set_config('lock_timeout',${defaults.lock},false)`;
   assert.deepEqual(await settings(),defaults);restored=true;maintenance.defaultsRestoredSamePid=true;
  }catch(error){maintenance.defaultsRestoredSamePid=false;primary=failed?new AggregateError([primary,error],'Maintenance restoration failed'):error;failed=true;}
  if(restored){try{connection.release();maintenance.released=true;}catch(error){restored=false;primary=failed?new AggregateError([primary,error],'Maintenance release failed'):error;failed=true;}}
  if(!restored){
   // Installed reserve() has release(), but no physical .end(). Poison the real
   // owner pool instead of returning uncertain session settings to another user.
   maintenance.ownerPoolPoisoned=true;
   try{await owner.client.end({timeout:5});maintenance.poisonedPoolClosed=true;}catch(error){primary=failed?new AggregateError([primary,error],'Maintenance pool close failed'):error;failed=true;}
  }
  if(failed)maintenance.status='refused';maintenance.complete=!failed&&maintenance.status==='completed'&&restored;
  try{save();}catch(error){primary=failed?new AggregateError([primary,error],'Maintenance receipt persistence failed'):error;failed=true;}
 }
 if(failed){maintenance.status='refused';maintenance.complete=false;throw primary;}
}

/** Hash native content on the server; receipts contain no HR rows or SQL bodies. */
export async function nativeModuleFingerprint(){
 const [catalogue]=await owner.client`select
  (select md5(string_agg(md5(to_jsonb(p)::text),'' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app')as functions,
  (select md5(string_agg(md5(to_jsonb(p)::text),'' order by p.oid)) from pg_policy p)as policies,
  (select md5(string_agg(md5(to_jsonb(c)::text),'' order by c.oid)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','app'))as relations,
  (select md5(string_agg(md5(to_jsonb(a)::text),'' order by a.attrelid,a.attnum)) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','app'))as columns,
  (select md5(string_agg(md5(to_jsonb(d)::text),'' order by d.oid)) from pg_attrdef d)as defaults,
  (select md5(string_agg(md5(to_jsonb(i)::text),'' order by i.indexrelid)) from pg_index i)as indexes,
  (select md5(string_agg(md5(to_jsonb(s)::text),'' order by s.starelid,s.staattnum,s.stainherit)) from pg_statistic s join pg_class c on c.oid=s.starelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','app'))as statistics`;
 const data:Record<string,unknown>={};
 for(const table of ['person','employment','assignment','attendance','company','department','app_user','role_assignment','domain_event','leave_ledger']){
  const [row]=await owner.db.execute(sql`select count(*)::integer as rows,md5(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)))as contents from ${sql.identifier(table)} t`);
  data[table]=row;
 }
 return {catalogue,data};
}

export function actualDriverPins(){
 const session=fileURLToPath(import.meta.resolve('drizzle-orm/postgres-js/session'));
 const index=fileURLToPath(import.meta.resolve('postgres')),connection=join(dirname(index),'connection.js');
 const drizzleVersion=JSON.parse(readFileSync(join(dirname(session),'../package.json'),'utf8')).version;
 const postgresVersion=JSON.parse(readFileSync(join(dirname(index),'../package.json'),'utf8')).version;
 const s=readFileSync(session,'utf8'),i=readFileSync(index,'utf8'),c=readFileSync(connection,'utf8');
 assert.equal(drizzleVersion,'0.45.2');assert.equal(postgresVersion,'3.4.9');
 assert(s.includes('client.unsafe(query, params)'));assert(/prepare: false/.test(i));
 assert(c.includes("'prepare' in q.options ? q.options.prepare : true"));
 return {drizzleVersion,postgresVersion,sessionSha256:bytesDigest(s),unsafeIndexSha256:bytesDigest(i),connectionSha256:bytesDigest(c),ordinaryBuilderUsesUnsafeUnprepared:true};
}

const numericKeys=['Startup Cost','Total Cost','Plan Rows','Plan Width','Actual Startup Time','Actual Total Time','Actual Rows','Actual Loops',
 'Rows Removed by Filter','Rows Removed by Join Filter','Heap Fetches','Shared Hit Blocks','Shared Read Blocks','Shared Dirtied Blocks','Shared Written Blocks',
 'Local Hit Blocks','Local Read Blocks','Local Dirtied Blocks','Local Written Blocks','Temp Read Blocks','Temp Written Blocks','I/O Read Time','I/O Write Time',
 'Sort Space Used','Hash Buckets','Hash Batches','Peak Memory Usage','Workers Planned','Workers Launched'];
function safePlan(raw:unknown){
 assert(Array.isArray(raw)&&raw.length===1);const root=raw[0] as Record<string,any>;
 const nodes:Record<string,unknown>[]=[],maximumNodes=2048;let overflow=0;
 function visit(node:Record<string,any>,parent:number|null){
  if(nodes.length===maximumNodes){overflow++;return;}
  const ordinal=nodes.length,item:Record<string,unknown>={ordinal,parent};nodes.push(item);
  for(const key of ['Node Type','Join Type','Strategy','Scan Direction','Sort Method','Sort Space Type','Parent Relationship'])
   if(typeof node[key]==='string'&&/^[A-Za-z0-9 _-]{1,96}$/.test(node[key]))item[key]=node[key];
  for(const key of ['Schema','Relation Name','Index Name','Function Name','CTE Name'])
   if(typeof node[key]==='string'&&/^[a-zA-Z_][a-zA-Z_0-9]{0,95}$/.test(node[key]))item[key]=node[key];
  if(typeof node['Subplan Name']==='string'){
   const label=/^(InitPlan|SubPlan) ([0-9]+)/.exec(node['Subplan Name']);if(label)item.subplan=label[1]+' '+label[2];
  }
  for(const key of numericKeys)if(typeof node[key]==='number'){assert(Number.isFinite(node[key]));item[key]=node[key];}
  for(const child of node.Plans??[])visit(child,ordinal);
 }
 assert(root.Plan);visit(root.Plan,null);
 const timing=root.JIT?.Timing,jit=root.JIT?{functions:root.JIT.Functions,options:Object.fromEntries(['Inlining','Optimization','Expressions','Deforming'].map(key=>{assert(typeof root.JIT.Options[key]==='boolean');return [key,root.JIT.Options[key]];})),
  timing:timing?Object.fromEntries(['Generation','Inlining','Optimization','Emission','Total'].map(key=>[key,timing[key]])):null}:null;
 if(jit){assert(Number.isSafeInteger(jit.functions));assert(jit.timing);for(const n of Object.values(jit.timing))assert(typeof n==='number'&&Number.isFinite(n)&&n>=0);}
 assert.equal(overflow,0,'Native plan detail overflow');
 assert(typeof root['Execution Time']==='number'&&typeof root['Planning Time']==='number');
 return {rawPlanSha256:digest(raw),planningMs:root['Planning Time'],executionMs:root['Execution Time'],jit,nodes,limits:{maximumNodes},overflow,detailComplete:true,
  settings:Object.fromEntries(Object.entries(root.Settings??{}).filter(([key])=>['jit','jit_above_cost','jit_inline_above_cost','jit_optimize_above_cost','work_mem','hash_mem_multiplier','plan_cache_mode'].includes(key)))};
}

export async function createModuleReadJitProbe(ctx:SessionContext,save:()=>void){
 // Registered sole-file admission precedes this function; it owns the fixture pool.
 await database.client.end({timeout:5});
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','module_read_jit_'+randomUUID().replaceAll('-',''));
 const single=database.createDb(url.toString(),{max:1}),dialect=new PgDialect();assert.equal(single.client.options.max,1);
 try{
 const audit=(text:string)=>single.client.unsafe(text,[],{prepare:false});
 const settings=async()=>{const [row]=await audit(settingSql);return row as unknown as Settings;};
 const defaults=await settings();assert.equal(defaults.role,'ai_hr_app');assert.equal(defaults.login,'ai_hr_app');assert.equal(defaults.jit,'on');assert(defaults.available);assert.equal(defaults.rls,'on');
 const prepared=async()=>{
  const rows=await audit(`select md5(name)as name_digest,md5(statement)as statement_digest,parameter_types::text as types,generic_plans::text as generic,custom_plans::text as custom from pg_prepared_statements order by name limit 129`);
  assert(rows.length<=128,'Prepared audit detail overflow');return Array.from(rows);
 };
 let busy=false,poisoned=false,closed=false,mode:JitMode='on',calls=0;
 let queries:CapturedStatement[]=[],identities:unknown[]=[];const pending=new Set<Promise<unknown>>(),owned=new Set<Promise<unknown>>();
 const receipts:Record<string,unknown>[]=[],plans:Record<string,unknown>[]=[];
 const tracked=<T>(work:Promise<T>)=>{pending.add(work);void work.catch(()=>{});void work.finally(()=>pending.delete(work)).catch(()=>{});return work;};
 function observe<T>(statement:SQL,work:()=>PromiseLike<T>):Promise<T>{
  const compiled=dialect.sqlToQuery(statement);assert(queries.length<256,'Statement detail overflow');
  const entry:CapturedStatement={statement,text:compiled.sql,params:compiled.params,digest:bytesDigest(compiled.sql),classification:classifyNativeStatement(compiled.sql),ordinal:queries.length+1,rows:null,elapsedMs:0,succeeded:false};queries.push(entry);
  return tracked((async()=>{const start=performance.now();try{const result=await work();entry.rows=Array.isArray(result)?result.length:null;entry.succeeded=true;return result;}finally{entry.elapsedMs=performance.now()-start;}})());
 }
 const wrap=(query:object):object=>new Proxy(query,{get(target,key,receiver){
  const value=Reflect.get(target,key,receiver);
  if(key==='then')return (resolve:(rows:unknown)=>unknown,reject:(error:unknown)=>unknown)=>observe((target as{getSQL:()=>SQL}).getSQL(),()=>Reflect.apply(value,target,[(rows:unknown)=>rows])).then(resolve,reject);
  return typeof value==='function'?(...args:unknown[])=>{const result=Reflect.apply(value,target,args);return result&&typeof result==='object'&&'then'in result?wrap(result):result;}:value;
 }});
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>{
  assert(busy&&!poisoned&&!closed,'No exclusive diagnostic ownership');assert.equal(++calls,1,'An actual module read must use one transaction');assert.deepEqual(options,{readOnlySnapshot:true});assert.deepEqual(context,ctx);
  return single.withTenant(context,async tx=>{
   await tx.execute(sql`select set_config('jit',${mode},true)`);
   const [identity]=await tx.execute<{pid:number;role:string;login:string;tenant:string;user:string;isolation:string;readOnly:boolean;jit:string;employment:boolean;assignment:boolean;person:boolean;company:boolean}>(sql`
    select pg_backend_pid()as pid,current_user as role,session_user as login,app.current_tenant_id()as tenant,app.current_user_id()as "user",
     current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')='on'as "readOnly",current_setting('jit')as jit,
     row_security_active('public.employment'::regclass)as employment,row_security_active('public.assignment'::regclass)as assignment,row_security_active('public.person'::regclass)as person,row_security_active('public.company'::regclass)as company`);
   assert.deepEqual(identity,{pid:defaults.pid,role:'ai_hr_app',login:'ai_hr_app',tenant:ctx.tenantId,user:ctx.userId,isolation:'repeatable read',readOnly:true,jit:mode,employment:true,assignment:true,person:true,company:true});
   const [controlled]=await tx.execute(sql.raw(settingSql));assert.deepEqual(controlled,{...defaults,jit:mode});
   identities.push({pid:identity.pid,role:identity.role,login:identity.login,isolation:identity.isolation,readOnly:identity.readOnly,jit:identity.jit,allPrincipalAndRlsFactsExact:true});
   const proxy=new Proxy(tx,{get(target,key,receiver){
    if(key==='select'||key==='selectDistinct')return (...args:unknown[])=>wrap(Reflect.apply(target[key],target,args));
    if(key==='execute')return (query:SQL)=>observe(query,()=>target.execute(query));
    const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
   }});
   const start=performance.now();let bodyFinished=false;try{const result=await read(proxy);await Promise.allSettled([...pending]);callbackMs=performance.now()-start;bodyFinished=true;
    const [after]=await tx.execute(sql.raw(settingSql));assert.deepEqual(after,{...defaults,jit:mode});return result;}finally{
    // Query await sums overlap under the preserved same-Tx Promise.all bodies.
    await Promise.allSettled([...pending]);if(!bodyFinished)callbackMs=performance.now()-start;
   }
  },options);
 });
 let callbackMs=0;
 async function run<T>(label:string,jit:JitMode,work:()=>Promise<T>){
  assert(!busy&&!poisoned&&!closed,'Diagnostic owner is busy, poisoned or closed');busy=true;mode=jit;calls=0;queries=[];identities=[];callbackMs=0;
  const receipt:Record<string,unknown>={label,mode:jit,complete:false,freshPlan:false,firstSampleIsStorageCold:false};receipts.push(receipt);save();
  let primary:unknown,hasPrimary=false,result:T|undefined;const operation=(async()=>{
   try{
    assert.deepEqual(await settings(),defaults);await audit('discard plans');receipt.freshPlan=true;receipt.preparedBefore=await prepared();
    const started=performance.now();try{result=await work();}finally{receipt.wallMs=performance.now()-started;receipt.callbackMs=callbackMs;}
    assert.equal(calls,1);assert.equal(pending.size,0);receipt.preparedAfter=await prepared();receipt.identities=identities;
    receipt.statements=queries.map(({digest,classification,ordinal,rows,elapsedMs,succeeded})=>({digest,classification,ordinal,rows,elapsedMs,succeeded}));
    receipt.census={statements:queries.length,rows:queries.reduce((n,q)=>n+(q.rows??0),0),unknownRows:queries.filter(q=>q.rows===null).length,failed:queries.filter(q=>!q.succeeded).length};
    receipt.controlAndOwnerMs=(receipt.wallMs as number)-callbackMs;receipt.complete=true;
   }catch(error){hasPrimary=true;primary=error;receipt.failed=true;}
   finally{
    await Promise.allSettled([...pending]);
    receipt.identities=identities;receipt.transactionCalls=calls;
    receipt.statements=queries.map(({digest,classification,ordinal,rows,elapsedMs,succeeded})=>({digest,classification,ordinal,rows,elapsedMs,succeeded}));
    receipt.census={statements:queries.length,rows:queries.reduce((n,q)=>n+(q.rows??0),0),unknownRows:queries.filter(q=>q.rows===null).length,failed:queries.filter(q=>!q.succeeded).length,unclassified:queries.filter(q=>q.classification==='unclassified').length};
    try{assert.deepEqual(await settings(),defaults);receipt.defaultsRestoredSamePid=true;}catch(error){poisoned=true;receipt.defaultsRestoredSamePid=false;primary=hasPrimary?new AggregateError([primary,error],'Diagnostic restoration failed'):error;hasPrimary=true;}
    receipt.complete=receipt.complete===true&&!hasPrimary;busy=false;
    try{save();}catch(error){primary=hasPrimary?new AggregateError([primary,error],'Diagnostic receipt persistence failed'):error;hasPrimary=true;}
   }
   if(hasPrimary)throw primary;return {value:result!,queries:queries.slice(),receipt};
  })();owned.add(operation);void operation.finally(()=>owned.delete(operation)).catch(()=>{});return operation;
 }
 async function explain(module:'attendance'|'analytics',jit:JitMode,shape:CapturedStatement,order:number){
  assert(plans.length<20,'Plan detail overflow');assert(/^\s*select\b/i.test(shape.text));const label=module+'-plan-'+order+'-'+jit;
  const result=await run(label,jit,()=>{
   const explainTx=async(tx:Tx)=>{
    const rows=await tx.execute<Record<string,unknown>>(sql`explain(analyze,buffers,timing on,settings,format json) ${shape.statement}`);
    return safePlan(rows[0]?.['QUERY PLAN']);
   };
   return module==='attendance'?withModulePresentationRead(ctx,'attendance',tx=>explainTx(tx)):
    database.withTenant(ctx,async tx=>{await assertAiPresentationPrincipalTx(tx,ctx);return explainTx(tx);},{readOnlySnapshot:true});
  });
  const plan={module,mode:jit,order,digest:shape.digest,...result.value};plans.push(plan);save();
  if(jit==='off')assert.equal(plan.jit,null);else if(Number(plan.nodes[0]['Total Cost'])>Number(defaults.above))assert(plan.jit,'Eligible native on plan must actually compile');
  return plan;
 }
 async function close(){
  closed=true;const settled=await Promise.allSettled([...owned]);spy.mockRestore();
  const errors:unknown[]=[];try{assert.equal(pending.size,0);assert.deepEqual(await settings(),defaults);}catch(error){errors.push(error);}
  try{await single.client.end({timeout:5});}catch(error){errors.push(error);}
  const rejected=settled.filter((r):r is PromiseRejectedResult=>r.status==='rejected');errors.push(...rejected.map(r=>r.reason));
  if(errors.length)throw new AggregateError(errors,'Diagnostic owner cleanup failed');
 }
 return {run,explain,close,defaults,receipts,plans,
  sameQueries:(a:CapturedStatement[],b:CapturedStatement[])=>a.length===b.length&&a.every((q,i)=>q.text===b[i].text&&isDeepStrictEqual(q.params,b[i].params)&&q.rows===b[i].rows),
  snapshot:()=>({defaults,receipts,plans,poisoned,busy,closed,pendingQueries:pending.size,ownedOperations:owned.size,maxAppConnections:1,
   limits:{statementsPerCall:256,preparedStatements:128,plans:20,planNodes:2048},includesSqlParamsResultsOrNativeErrorContent:false})};
 }catch(error){try{await single.client.end({timeout:5});}catch(cleanup){throw new AggregateError([error,cleanup],'Diagnostic construction cleanup failed');}throw error;}
}
