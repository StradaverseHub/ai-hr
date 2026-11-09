import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {carryForwardReportPage} from '../core/analytics';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {parsePageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,owner} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';

const POPULATION=50_000, FIXTURE_BATCH=5_000, FETCH_SIZE=4_096;
const CASE_MS=300_000, CELL_MS=120_000, STATEMENT_MS=20_000, SETTLEMENT_MS=10_000;
const PLAN_BYTES=1_048_576, PLAN_NODES=256, PLAN_DEPTH=64, RECEIPT_BYTES=65_536;
const RECEIPT='analytics-carry-searched-native-50k.json';
const EXPLAIN_PREFIX='explain(analyze,buffers,verbose,settings,timing off,format json) ';
const CELLS=[
 {name:'missing',q:'Fictional absent carry witness',first:1,total:0,batches:[0]},
 {name:'sparse',q:'Personnel 00000001',first:10,total:10,batches:[10]},
 {name:'dense',q:'PeRsOnNeL',first:1,total:POPULATION,batches:[...Array<number>(12).fill(FETCH_SIZE),848]},
] as const;
const SETTINGS=[
 'cursor_tuple_fraction','effective_cache_size','effective_io_concurrency','enable_bitmapscan',
 'enable_gathermerge','enable_hashjoin','enable_incremental_sort','enable_indexonlyscan','enable_indexscan',
 'enable_material','enable_memoize','enable_mergejoin','enable_nestloop','enable_parallel_append',
 'enable_seqscan','enable_sort','hash_mem_multiplier','jit','jit_above_cost','jit_inline_above_cost',
 'jit_optimize_above_cost','lock_timeout','max_parallel_workers_per_gather','parallel_setup_cost',
 'parallel_tuple_cost','plan_cache_mode','random_page_cost','row_security','seq_page_cost',
 'statement_timeout','work_mem',
] as const;
const dialect=new PgDialect();
type Cell=(typeof CELLS)[number];
type Fixture=Awaited<ReturnType<typeof seedPersonnelNativeFixture>>;
type Identity={pid:number;backend_start:string;db:string;role:string};
type Settings=Record<(typeof SETTINGS)[number],string>;
type Page=Awaited<ReturnType<typeof carryForwardReportPage>>;
type Phase='fixture'|'oracle'|Cell['name']|'analyze'|'settlement'|'receipt';
type Failure={phase:Phase;kind:'clock'|'postgres'|'course';sqlState?:string};
type Declaration={statement:SQL;compiled:ReturnType<PgDialect['sqlToQuery']>};
type FixtureRange={prefix:string;size:number;first:number;last:number;ordinals:number;active:number;terminated:number;valid:number};
type CellEvidence={
 name:Cell['name'];productWallMs?:number;identityStreamMs?:number;declareMs?:number;closeMs?:number;
 declareCount:number;closeCount:number;fetches:{rows:number;nativeMs:number}[];firstFetchMs?:number;
 failedCursorAwait?:{operation:'declare'|'fetch'|'close';nativeMs:number};
 streamVerificationMs:number;pageVerificationMs?:number;seen:number;pageRows?:number;total?:number;
};
class CourseClockError extends Error {}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');

function requireRoom(end:number,reserve=0,signal?:AbortSignal) {
 if(signal?.aborted||performance.now()+reserve>=end)throw new CourseClockError('Searched Carry course deadline reached');
}

function failureFact(error:unknown,phase:Phase):Failure {
 const sqlState=pgSqlState(error);
 return {phase,kind:error instanceof CourseClockError?'clock':sqlState?'postgres':'course',...(sqlState?{sqlState}:{})};
}

/** Start one native thenable at a time. The transaction callback and its active
 * statement remain owned if the driver's outer transaction rejects first. */
class ReadLane {
 private active:Promise<unknown>|undefined;
 private stopped=false;

 constructor(private readonly end:number,private readonly signal:AbortSignal,private readonly onFailure:(error:unknown)=>void) {}

 async run<T>(start:()=>PromiseLike<T>):Promise<T> {
  requireRoom(this.end,STATEMENT_MS,this.signal);
  if(this.stopped)throw new Error('Searched Carry native admission closed');
  if(this.active)throw new Error('Concurrent searched Carry statements refused');
  const query=start();
  // Invoke the actual builder/driver then method in this admission turn.
  const pending=new Promise<T>((resolve,reject)=>{void query.then(resolve,reject);});
  this.active=pending;
  try {
   const value=await pending;
   requireRoom(this.end,0,this.signal);
   return value;
  } catch(error) {
   this.stop();
   this.onFailure(error);
   throw error;
  } finally {
   this.active=undefined;
  }
 }

 stop() { this.stopped=true; }

 async drain() {
  await this.active?.then(()=>undefined,()=>undefined);
 }
}

const fixedBatchName=(ordinal:number)=>'Fictional retained Personnel '+String(ordinal).padStart(9,'0');

function expectedId(prefixes:string[],ordinal:number) {
 return prefixes[Math.floor((ordinal-1)/FIXTURE_BATCH)]+String(ordinal).padStart(12,'0');
}

async function readFixtureOracle(tx:Tx,fixture:Fixture,lane:ReadLane) {
 const {b,foreign,foreignEmployment}=fixture;
 const ranges=await lane.run(()=>tx.execute<FixtureRange>(sql`
  select left(e.id::text,24) as prefix,count(*)::int as size,
   min(substring(e.employee_code from 5)::int) as first,max(substring(e.employee_code from 5)::int) as last,
   count(distinct substring(e.employee_code from 5)::int)::int as ordinals,
   count(*) filter(where e.terminated_on is null)::int as active,
   count(*) filter(where e.terminated_on='2024-01-01')::int as terminated,
   count(*) filter(where e.hired_on='2020-01-01' and e.employee_code ~ '^PERF[0-9]{9}$'
     and p.full_name='Fictional retained Personnel '||substring(e.employee_code from 5)
     and right(e.id::text,12)=lpad(substring(e.employee_code from 5),12,'0')
     and a.tenant_id=e.tenant_id and a.company_id=e.company_id and a.department_id=${b.deptA}::uuid
     and a.valid_from='2020-01-01' and a.valid_to is null and a.superseded_at is null)::int as valid
  from public.employment e join public.person p on p.id=e.person_id and p.tenant_id=e.tenant_id
  join public.assignment a on a.employment_id=e.id
  where e.tenant_id=${b.tenantId}::uuid and e.company_id=${b.companyId}::uuid
  group by left(e.id::text,24) order by first limit 11`));
 expect(ranges).toHaveLength(10);
 const prefixes=ranges.map((range,index)=>{
  const first=index*FIXTURE_BATCH+1;
  expect(range.prefix).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-$/);
  expect(range).toEqual({prefix:range.prefix,size:FIXTURE_BATCH,first,last:first+FIXTURE_BATCH-1,
   ordinals:FIXTURE_BATCH,active:4000,terminated:1000,valid:FIXTURE_BATCH});
  return range.prefix;
 });
 expect(new Set(prefixes).size).toBe(10);
 expect(fixture.expectedFirst).toEqual(Array.from({length:25},(_,index)=>expectedId(prefixes,index+1)));
 expect(fixture.expectedLast).toEqual(Array.from({length:25},(_,index)=>expectedId(prefixes,POPULATION-24+index)));

 const [facts]=await lane.run(()=>tx.execute<{
  db:string;company:boolean;department:boolean;annual:boolean;noLedger:boolean;noTemplates:boolean;foreign:boolean;
 }>(sql`select current_database()::text as db,
  exists(select 1 from public.company where id=${b.companyId}::uuid and tenant_id=${b.tenantId}::uuid
    and legal_name='Acme Sdn Bhd' and leave_cycle='calendar') as company,
  exists(select 1 from public.department where id=${b.deptA}::uuid and tenant_id=${b.tenantId}::uuid
    and company_id=${b.companyId}::uuid and name='Finance') as department,
  exists(select 1 from public.leave_type where id=${b.annualLeaveTypeId}::uuid and tenant_id=${b.tenantId}::uuid
    and code='ANNUAL' and carry_forward_max is null and carry_forward_percent is null and carry_forward_enabled is null
    and carry_forward_expiry_mode is null and carry_forward_expiry_months is null and carry_forward_expiry_month is null
    and carry_forward_expiry_day is null) as annual,
  not exists(select 1 from public.leave_ledger where tenant_id=${b.tenantId}::uuid) as "noLedger",
  not exists(select 1 from public.entitlement_template where tenant_id=${b.tenantId}::uuid) as "noTemplates",
  exists(select 1 from public.employment e join public.person p on p.id=e.person_id join public.company c on c.id=e.company_id
    where e.id=${foreignEmployment}::uuid and c.id=${foreign.companyId}::uuid and e.tenant_id=${foreign.tenantId}::uuid
      and c.tenant_id=e.tenant_id and p.tenant_id=e.tenant_id and p.full_name='Fictional outside Personnel'
      and p.full_name ilike '%PeRsOnNeL%') as "foreign"`));
 expect(facts).toEqual({db:expect.any(String),company:true,department:true,annual:true,noLedger:true,noTemplates:true,foreign:true});
 return {prefixes,db:facts.db};
}

async function readContext(tx:Tx,lane:ReadLane,fixture:Fixture,db:string,observe:(identity:Identity)=>void) {
 const {b,foreign,foreignEmployment}=fixture;
 const rows=await lane.run(()=>tx.execute<Identity&{
  login:string;tenant:string;actor:string;pg16:boolean;isolated:boolean;readOnly:boolean;unprivileged:boolean;
  protected:boolean;foreignHidden:boolean;settings:Settings;
 }>(sql`select pg_backend_pid() as pid,extract(epoch from a.backend_start)::text as backend_start,current_database()::text as db,
   current_user::text as role,session_user::text as login,app.current_tenant_id()::text as tenant,app.current_user_id()::text as actor,
   current_setting('server_version_num')::integer between 160000 and 169999 as pg16,
   current_setting('transaction_isolation')='repeatable read' as isolated,current_setting('transaction_read_only')='on' as "readOnly",
   not(r.rolsuper or r.rolbypassrls) as unprivileged,
   row_security_active('public.person'::regclass) and row_security_active('public.employment'::regclass)
     and row_security_active('public.company'::regclass) as protected,
   not exists(select 1 from public.person where tenant_id=${foreign.tenantId}::uuid and full_name='Fictional outside Personnel')
     and not exists(select 1 from public.employment where id=${foreignEmployment}::uuid)
     and not exists(select 1 from public.company where id=${foreign.companyId}::uuid) as "foreignHidden",
   (select jsonb_object_agg(name,current_setting(name)) from pg_settings
    where name in (${sql.join(SETTINGS.map(name=>sql`${name}`),sql`, `)})) as settings
   from pg_stat_activity a join pg_roles r on r.rolname=current_user where a.pid=pg_backend_pid()`));
 expect(rows).toHaveLength(1);
 const {pid,backend_start,db:actualDb,role,settings,...facts}=rows[0];
 if(!Number.isInteger(pid)||pid<=0||typeof backend_start!=='string'||!/^[0-9]{1,16}(\.[0-9]{1,6})?$/.test(backend_start)||
    actualDb!==db||role!=='ai_hr_app')throw new Error('Searched Carry backend identity refused');
 observe({pid,backend_start,db,role});
 expect(facts).toEqual({login:'ai_hr_app',tenant:b.tenantId,actor:b.adminUserId,pg16:true,isolated:true,
  readOnly:true,unprivileged:true,protected:true,foreignHidden:true});
 expect(Object.keys(settings).sort()).toEqual([...SETTINGS].sort());
 for(const setting of SETTINGS)expect(settings[setting]).toMatch(/^[a-zA-Z0-9_.-]{1,32}$/);
 expect(settings).toMatchObject({statement_timeout:'20s',lock_timeout:'300ms',row_security:'on'});
 expect(settings.jit).toMatch(/^(on|off)$/);
 expect(settings.work_mem).toMatch(/^[1-9][0-9]*(kB|MB|GB)$/);
 return settings;
}

function admitDeclaration(statement:SQL,cell:Cell,companyId:string):Declaration {
 const compiled=dialect.sqlToQuery(statement);
 const text=compiled.sql.replace(/\s+/g,' ').trim();
 const pattern='%'+cell.q+'%';
 if(compiled.sql.length>8192||
    !text.startsWith('declare analytics_carry_identities no scroll cursor for select "analytics_carry_population"."employment_id" as "employmentId","analytics_carry_population"."carried_name" as name from ( with "analytics_carry_scoped_employment" as not materialized (')||
    !text.includes('from "employment" where ("employment"."company_id" in ($1) and "employment"."company_id" = $2)')||
    !text.includes('max(person_name) over ( partition by person_id order by event_kind rows between unbounded preceding and current row ) as carried_name')||
    !text.includes('select "person"."id" as person_id, 0 as event_kind, null::uuid as employment_id, "person"."full_name" as person_name from "person" where ("person"."full_name" ilike $3 or "person"."primary_email" ilike $4)')||
    !text.includes('union all select "employment"."person_id", 1, "employment"."id", null::text from "analytics_carry_scoped_employment" as "employment"')||
    !text.includes('inner join "company" on "company"."id" = "employment"."company_id"')||
    !text.includes('"employment"."hired_on" <= $5 and ("employment"."terminated_on" is null or "employment"."terminated_on" >= $6)')||
    !text.endsWith('where employment_id is not null and carried_name is not null ) "analytics_carry_population" order by "analytics_carry_population"."employment_id"')||
    !isDeepStrictEqual(compiled.params,[companyId,companyId,pattern,pattern,'2020-12-31','2020-01-01'])) {
  throw new Error('Searched Carry declaration or ordered binds refused');
 }
 return {statement,compiled};
}

class CursorWitness {
 readonly evidence:CellEvidence;
 declaration:Declaration|undefined;
 private readonly census=new Uint8Array(POPULATION);
 private previousId='';
 private identityStarted=0;

 constructor(private readonly cell:Cell,private readonly fixture:Fixture,private readonly prefixes:string[]) {
  this.evidence={name:cell.name,declareCount:0,closeCount:0,fetches:[],streamVerificationMs:0,seen:0};
 }

 private async awaitCursor<T>(operation:'declare'|'fetch'|'close',lane:ReadLane,start:()=>PromiseLike<T>) {
  const started=performance.now();
  let submitted=false;
  try {
   const result=await lane.run(()=>{
    const query=start();
    submitted=true;
    return query;
   });
   return {result,nativeMs:performance.now()-started};
  } catch(error) {
   if(submitted) {
    const nativeMs=performance.now()-started;
    this.evidence.failedCursorAwait={operation,nativeMs};
    if(operation==='fetch')this.evidence.firstFetchMs??=nativeMs;
   }
   throw error;
  }
 }

 async execute(tx:Tx,lane:ReadLane,statement:SQL) {
  const text=dialect.sqlToQuery(statement).sql;
  const facts=this.evidence;
  if(text.startsWith('declare ')) {
   if(this.declaration)throw new Error('Duplicate searched Carry cursor declaration');
   const checking=performance.now();
   this.declaration=admitDeclaration(statement,this.cell,this.fixture.b.companyId);
   facts.streamVerificationMs+=performance.now()-checking;
   this.identityStarted=performance.now();
   const {result,nativeMs}=await this.awaitCursor('declare',lane,()=>tx.execute(statement));
   facts.declareCount++;
   facts.declareMs=nativeMs;
   return result;
  }
  if(text==='fetch forward 4096 from analytics_carry_identities') {
   const index=facts.fetches.length;
   if(facts.declareCount!==1||facts.closeCount||index>=this.cell.batches.length)throw new Error('Unexpected searched Carry FETCH');
   const {result:rows,nativeMs}=await this.awaitCursor('fetch',lane,()=>tx.execute<{employmentId:string;name:string}>(statement));
   facts.fetches.push({rows:rows.length,nativeMs});
   facts.firstFetchMs??=nativeMs;
   const checking=performance.now();
   expect(rows).toHaveLength(this.cell.batches[index]);
   for(const {employmentId,name} of rows) {
    const ordinal=Number(/^Fictional retained Personnel ([0-9]{9})$/.exec(name)?.[1]);
    if(!Number.isInteger(ordinal)||ordinal<this.cell.first||ordinal>=this.cell.first+this.cell.total||
       employmentId!==expectedId(this.prefixes,ordinal)||employmentId<=this.previousId||this.census[ordinal-1]) {
     throw new Error('Searched Carry identity membership, name or UUID order refused');
    }
    this.census[ordinal-1]=1;
    this.previousId=employmentId;
    facts.seen++;
   }
   facts.streamVerificationMs+=performance.now()-checking;
   return rows;
  }
  if(text==='close analytics_carry_identities') {
   if(facts.declareCount!==1||facts.closeCount||facts.fetches.length!==this.cell.batches.length||facts.seen!==this.cell.total) {
    throw new Error('Incomplete searched Carry identity stream before CLOSE');
   }
   const {result,nativeMs}=await this.awaitCursor('close',lane,()=>tx.execute(statement));
   facts.closeCount++;
   facts.closeMs=nativeMs;
   facts.identityStreamMs=performance.now()-this.identityStarted;
   return result;
  }
  if(!text.startsWith('select exists(select 1 from public.app_user u'))throw new Error('Unexpected searched Carry execute');
  return lane.run(()=>tx.execute(statement));
 }

 verifyPage(page:Page) {
  const checking=performance.now(),facts=this.evidence;
  const count=Math.min(this.cell.total,25);
  expect(page.state).toEqual({page:0,offset:0,limit:25,size:25,total:this.cell.total,from:count?1:0,to:count,
   hasPrev:false,hasNext:this.cell.total>count,truncated:false,ceiling:2000});
  expect(page.rows).toEqual(Array.from({length:count},(_,index)=>{
   const ordinal=this.cell.first+index;
   return {employmentId:expectedId(this.prefixes,ordinal),employeeName:fixedBatchName(ordinal),company:'Acme Sdn Bhd',
    department:'Finance',leaveYear:2020,cycleStart:'2020-01-01',carried:0,carryForwardExpiryDate:null,
    forfeitedAtOpen:0,forfeitedAtExpiry:0,reasonCodes:[]};
  }));
  expect(facts).toMatchObject({declareCount:1,closeCount:1,seen:this.cell.total});
  expect(facts.fetches.map(batch=>batch.rows)).toEqual(this.cell.batches);
  facts.pageRows=page.rows.length;
  facts.total=page.state.total;
  facts.pageVerificationMs=performance.now()-checking;
 }
}

function guardedTx(tx:Tx,lane:ReadLane,execute:(query:SQL)=>Promise<unknown>):Tx {
 const wrap=(builder:object):object=>new Proxy(builder,{get(target,key,receiver) {
  const value=Reflect.get(target,key,receiver);
  if(key==='then'&&typeof value==='function')return (
   resolve:(result:unknown)=>unknown,reject:(error:unknown)=>unknown,
  )=>lane.run(()=>target as PromiseLike<unknown>).then(resolve,reject);
  return typeof value==='function'?(...args:unknown[])=>{
   const result=Reflect.apply(value,target,args);
   return result&&typeof result==='object'&&'then' in result?wrap(result):result;
  }:value;
 }});
 return new Proxy(tx,{get(target,key,receiver) {
  if(key==='select'||key==='selectDistinct')return (...args:unknown[])=>wrap(Reflect.apply(target[key],target,args));
  if(key==='execute')return execute;
  const value=Reflect.get(target,key,receiver);
  if(typeof value==='function')throw new Error('Unexpected searched Carry transaction method');
  return value;
 }});
}

type PlanRecord=Record<string,unknown>;
type PlanEntry={node:PlanRecord;parent?:PlanEntry};
function record(value:unknown):value is PlanRecord {
 return typeof value==='object'&&value!==null&&!Array.isArray(value);
}
function metric(value:unknown,integer=false):number {
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||(integer&&!Number.isSafeInteger(value))) {
  throw new Error('Searched Carry native plan metric refused');
 }
 return value;
}
function planPath(entry:PlanEntry):PlanEntry[] {
 const path:PlanEntry[]=[];
 for(let step:PlanEntry|undefined=entry;step;step=step.parent)path.push(step);
 return path;
}

function verifyStreamTopology(entries:PlanEntry[]) {
 const relationship=({node}:PlanEntry)=>node['Parent Relationship'];
 const relation=({node}:PlanEntry,name:string)=>node.Schema==='public'&&node['Relation Name']===name;
 const main=(entry:PlanEntry)=>planPath(entry).every(step=>relationship(step)!=='InitPlan'&&relationship(step)!=='SubPlan');
 const mainEntries=entries.filter(main);
 const windows=mainEntries.filter(entry=>entry.node['Node Type']==='WindowAgg');
 const people=entries.filter(entry=>relation(entry,'person'));
 const employments=mainEntries.filter(entry=>relation(entry,'employment'));
 const companies=mainEntries.filter(entry=>relation(entry,'company'));
 if(windows.length!==1||people.length!==1||employments.length!==1||companies.length!==1||
    !main(people[0])||entries.some(entry=>relation(entry,'assignment')||relation(entry,'department'))) {
  throw new Error('Searched Carry native identity stream census refused');
 }
 const [window]=windows,[person]=people,[employment]=employments,[company]=companies;
 const scans=['Seq Scan','Index Scan','Index Only Scan','Bitmap Heap Scan'];
 if(![person,employment,company].every(entry=>scans.includes(String(entry.node['Node Type'])))) {
  throw new Error('Searched Carry native identity scan refused');
 }
 const personPath=planPath(person),employmentPath=planPath(employment),companyPath=planPath(company);
 const append=personPath.find(entry=>employmentPath.includes(entry));
 const appendKind=append?.node['Node Type'];
 if(!append||(appendKind!=='Append'&&appendKind!=='Merge Append')||!planPath(append).slice(1).includes(window)) {
  throw new Error('Searched Carry native identity stream ancestor refused');
 }
 const member=(path:PlanEntry[])=>path[path.indexOf(append)-1];
 const personMember=member(personPath),employmentMember=member(employmentPath);
 const repeated=personPath.some(entry=>relationship(entry)==='Inner'&&entry.parent?.node['Node Type']==='Nested Loop');
 if(repeated||!personMember||!employmentMember||personMember===employmentMember||
    relationship(personMember)!=='Member'||relationship(employmentMember)!=='Member'||
    member(companyPath)!==employmentMember||mainEntries.filter(entry=>entry.parent===append).length!==2) {
  throw new Error('Searched Carry native identity members refused');
 }
 return {appendKind,windows:windows.length,personReads:people.length,
  employmentReads:employments.length,companyReads:companies.length,
  policyEmploymentReads:entries.filter(entry=>!main(entry)&&relation(entry,'employment')).length};
}

function sortMetrics(node:PlanRecord) {
 const method=node['Sort Method'],spaceType=node['Sort Space Type'],space=node['Sort Space Used'];
 if(method===undefined&&spaceType===undefined&&space===undefined)return null;
 if(typeof method!=='string'||!['quicksort','top-N heapsort','external sort','external merge','still in progress'].includes(method)||
    (spaceType!=='Memory'&&spaceType!=='Disk'))throw new Error('Searched Carry native sort method refused');
 return {method,spaceType,spaceKiB:metric(space,true)};
}

function bufferMetrics(node:PlanRecord) {
 return {tempReadBlocks:metric(node['Temp Read Blocks']??0,true),tempWrittenBlocks:metric(node['Temp Written Blocks']??0,true)};
}

function summarizePlan(raw:unknown) {
 if(!Array.isArray(raw)||raw.length!==1||!record(raw[0])||!record(raw[0].Plan)) {
  throw new Error('Searched Carry analyzed plan envelope refused');
 }
 const encoded=JSON.stringify(raw),bytes=Buffer.byteLength(encoded);
 if(bytes>PLAN_BYTES)throw new Error('Searched Carry analyzed plan byte bound exceeded');
 const document=raw[0],root=document.Plan as PlanRecord,entries:PlanEntry[]=[];
 const visit=(node:PlanRecord,depth:number,parent?:PlanEntry)=>{
  if(entries.length>=PLAN_NODES||depth>PLAN_DEPTH)throw new Error('Searched Carry analyzed plan shape bound exceeded');
  const entry={node,parent};
  entries.push(entry);
  if(node.Plans!==undefined) {
   if(!Array.isArray(node.Plans))throw new Error('Searched Carry native child plans refused');
   for(const child of node.Plans) {
    if(!record(child))throw new Error('Searched Carry native child plan refused');
    visit(child,depth+1,entry);
   }
  }
 };
 visit(root,1);
 const topology=verifyStreamTopology(entries);
 expect(metric(root['Actual Rows'],true)).toBe(POPULATION);
 expect(metric(root['Actual Loops'],true)).toBe(1);
 const nodes=entries.map(({node,parent})=>{
  const type=node['Node Type'];
  if(typeof type!=='string'||!/^[a-zA-Z][a-zA-Z ]{0,35}$/.test(type))throw new Error('Searched Carry native node type refused');
  const rows=metric(node['Actual Rows'],true),loops=metric(node['Actual Loops'],true);
  const sort=sortMetrics(node);
  // This component only accepts the ordinary Sort telemetry shape. Do not
  // report aggregate zero for an unmeasured incremental sort.
  if(type==='Incremental Sort')throw new Error('Searched Carry incremental sort telemetry unavailable');
  const workers=node.Workers??[];
  if(!Array.isArray(workers)||workers.length>16)throw new Error('Searched Carry native worker details refused');
  const workerSorts=workers.map(worker=>{
   if(!record(worker))throw new Error('Searched Carry native worker details refused');
   return {worker:metric(worker['Worker Number'],true),...bufferMetrics(worker),sort:sortMetrics(worker)};
  });
  return {type,parent:parent?entries.indexOf(parent):null,rows,loops,...bufferMetrics(node),sort,
   ...(workerSorts.length?{workerSorts}:{})};
 });
 if(!nodes.some(node=>node.sort||node.workerSorts?.some(worker=>worker.sort))) {
  throw new Error('Searched Carry analyzed plan has no measured sort');
 }
 const settings=document.Settings;
 if(settings!==undefined&&(!record(settings)||Object.values(settings).some(value=>typeof value!=='string'))) {
  throw new Error('Searched Carry analyzed settings refused');
 }
 const jit=document.JIT;
 if(jit!==undefined&&(!record(jit)||!record(jit.Options)||
    Object.keys(jit.Options).sort().join(',')!=='Deforming,Expressions,Inlining,Optimization'||
    Object.values(jit.Options).some(value=>typeof value!=='boolean')))throw new Error('Searched Carry analyzed JIT refused');
 return {bytes,sha256:hash(encoded),topology,nodes,planningMs:metric(document['Planning Time']),
  executionMs:metric(document['Execution Time']),rootTempReadBlocks:nodes[0].tempReadBlocks,
  rootTempWrittenBlocks:nodes[0].tempWrittenBlocks,settingsCount:record(settings)?Object.keys(settings).length:0,
  jit:record(jit)?{functions:metric(jit.Functions,true),options:jit.Options}:null};
}

type Receipt={
 kind:'SEARCHED_CARRY_50000_NATIVE_COMPONENT';status:'INCOMPLETE'|'COMPLETE';
 fixture:Record<string,unknown>;cells:CellEvidence[];observedBackends:number;settlement:'UNOBSERVED'|'CONFIRMED'|'REFUSED';
 analyze?:{nativeMs?:number;nativeStarted:boolean;declarationSha256:string;parameterCount:number;settingsSha256:string;
  settings:Settings;plan?:ReturnType<typeof summarizePlan>};
 failure?:Failure;secondarySettlementFailure?:Failure;
};

let completion:Promise<void>|undefined;
let safeToClose=true;
beforeAll(async()=>{await migrateTestDb();},30_000);
afterAll(async()=>{
 await completion;
 if(safeToClose)await closeAll();
},30_000);

it('qualifies the actual searched Carry cursor and first page over 50,000 employments',async ({signal})=>{
 const started=performance.now(),caseEnd=started+CASE_MS,workEnd=caseEnd-SETTLEMENT_MS;
 const report:Receipt={kind:'SEARCHED_CARRY_50000_NATIVE_COMPONENT',status:'INCOMPLETE',fixture:{},cells:[],
  observedBackends:0,settlement:'UNOBSERVED'};
 const identities:Identity[]=[];
 const actual=database.withTenant;
 let failure:{error:unknown;fact:Failure}|undefined;
 let uncertain=false;
 let phase:Phase='fixture';
 let nativeRealm:string|undefined;
 let nativeSettings:Settings|undefined;

 const remember=(error:unknown)=>{
  if(!failure) {
   const fact=failureFact(error,phase);
   failure={error,fact};
   report.failure=fact;
  }
 };
 const cellEnd=()=>Math.min(workEnd,performance.now()+CELL_MS);
 const store=()=>{
  const payload=JSON.stringify(report);
  if(Buffer.byteLength(payload)>RECEIPT_BYTES)throw new Error('Searched Carry receipt byte bound exceeded');
  const directory=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if(directory)writeFileSync(join(directory,RECEIPT),payload,{mode:0o600});
 };

 async function inOwner<T>(lane:ReadLane,body:(tx:Tx)=>Promise<T>) {
  let callback:Promise<T>|undefined;
  try {
   return await owner.db.transaction(tx=>{
    callback=body(tx);
    return callback;
   });
  } catch(error) {
   lane.stop();
   uncertain=true;
   remember(error);
   throw error;
  } finally {
   await callback?.then(()=>undefined,()=>undefined);
   await lane.drain();
  }
 }

 async function inApp<T>(ctx:SessionContext,fixture:Fixture,db:string,end:number,body:(tx:Tx,lane:ReadLane)=>Promise<T>) {
  const lane=new ReadLane(end,signal,remember);
  let callback:Promise<T>|undefined,identified=false;
  requireRoom(end,STATEMENT_MS,signal);
  try {
   const result=await actual(ctx,tx=>{
    callback=(async()=>{
     await lane.run(()=>tx.execute(sql`set local statement_timeout='20s'`));
     await lane.run(()=>tx.execute(sql`set local lock_timeout='300ms'`));
     const settings=await readContext(tx,lane,fixture,db,identity=>{
      if(identities.length>=4)throw new Error('Searched Carry app transaction census exceeded');
      identities.push(identity);
      identified=true;
     });
     if(nativeSettings)expect(settings).toEqual(nativeSettings);
     else nativeSettings=settings;
     return body(tx,lane);
    })();
    return callback;
   },{readOnlySnapshot:true,readSignal:signal});
   requireRoom(end,0,signal);
   return result;
  } catch(error) {
   lane.stop();
   remember(error);
   throw error;
  } finally {
   await callback?.then(()=>undefined,()=>undefined);
   await lane.drain();
   if(!identified)uncertain=true;
  }
 }

 async function proveIdle() {
  if(uncertain||!nativeRealm||!identities.length)throw new Error('Searched Carry has an unconfirmed transaction identity');
  // This owner control is part of the existing cleanup reserve. A timeout or a
  // disappeared backend cannot substitute for observing the exact backend idle.
  requireRoom(caseEnd,1_000);
  let callback:Promise<void>|undefined,stopped=false;
  const check=()=>{
   if(stopped)throw new Error('Searched Carry settlement admission closed');
   requireRoom(caseEnd,1_000);
  };
  try {
   await owner.db.transaction(tx=>{
    callback=(async()=>{
     check();
     await tx.execute(sql`set local statement_timeout='1s'`);
     check();
     await tx.execute(sql`set local lock_timeout='300ms'`);
     check();
     const [result]=await tx.execute<{matched:number;idle:number;db:string}>(sql`
      select count(a.pid)::int as matched,count(a.pid) filter(where a.state='idle' and a.xact_start is null)::int as idle,
       current_database()::text as db
      from jsonb_to_recordset(${JSON.stringify(identities)}::jsonb) i(pid integer,backend_start text,db text,role text)
      left join pg_stat_activity a on a.pid=i.pid and extract(epoch from a.backend_start)::text=i.backend_start
       and a.datname=i.db and a.usename=i.role`);
     expect(result).toEqual({matched:identities.length,idle:identities.length,db:nativeRealm});
    })();
    return callback;
   });
  } catch(error) {
   stopped=true;
   throw error;
  } finally {
   await callback?.then(()=>undefined,()=>undefined);
  }
  requireRoom(caseEnd);
  report.observedBackends=new Set(identities.map(identity=>identity.pid+'/'+identity.backend_start)).size;
  report.settlement='CONFIRMED';
  safeToClose=true;
 }

 async function runCourse() {
  safeToClose=false;
  try {
   const fixtureStarted=performance.now(),fixtureEnd=cellEnd();
   requireRoom(fixtureEnd,STATEMENT_MS,signal);
   uncertain=true;
   const fixture=await seedPersonnelNativeFixture(POPULATION,report.fixture,
    ()=>requireRoom(fixtureEnd,STATEMENT_MS,signal),()=>requireRoom(fixtureEnd,STATEMENT_MS,signal));
   uncertain=false;
   report.fixture.elapsedMs=performance.now()-fixtureStarted;
   requireRoom(fixtureEnd,0,signal);

   phase='oracle';
   const oracleEnd=cellEnd(),oracleLane=new ReadLane(oracleEnd,signal,remember);
   const {prefixes,db}=await inOwner(oracleLane,async tx=>{
    await oracleLane.run(()=>tx.execute(sql`set local statement_timeout='20s'`));
    await oracleLane.run(()=>tx.execute(sql`set local lock_timeout='300ms'`));
    return readFixtureOracle(tx,fixture,oracleLane);
   });
   requireRoom(oracleEnd,0,signal);
   nativeRealm=db;
   let dense:Declaration|undefined;
   for(const cell of CELLS) {
    phase=cell.name;
    const end=cellEnd(),witness=new CursorWitness(cell,fixture,prefixes);
    report.cells.push(witness.evidence);
    let calls=0,owned:Promise<unknown>|undefined;
    const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(
     ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof actual>[2],
    )=>{
     if(++calls!==1||ctx.tenantId!==fixture.b.tenantId||ctx.userId!==fixture.b.adminUserId||
        !isDeepStrictEqual(options,{readOnlySnapshot:true}))throw new Error('Searched Carry transaction admission refused');
     const pending=inApp(ctx,fixture,db,end,(tx,lane)=>read(guardedTx(tx,lane,query=>witness.execute(tx,lane,query))));
     owned=pending;
     return pending;
    });
    const pageStarted=performance.now();
    try {
     const page=await carryForwardReportPage(fixture.ctx,[fixture.b.companyId],{
      year:2020,companyId:fixture.b.companyId,filter:{q:cell.q},page:parsePageQuery(),
     });
     witness.evidence.productWallMs=performance.now()-pageStarted;
     requireRoom(end,0,signal);
     expect(calls).toBe(1);
     witness.verifyPage(page);
     requireRoom(end,0,signal);
     if(cell.name==='dense')dense=witness.declaration;
    } finally {
     witness.evidence.productWallMs??=performance.now()-pageStarted;
     await owned?.then(()=>undefined,()=>undefined);
     spy.mockRestore();
    }
   }
   expect(report.cells.reduce((n,cell)=>n+cell.declareCount,0)).toBe(3);
   expect(report.cells.reduce((n,cell)=>n+cell.fetches.length,0)).toBe(15);
   expect(report.cells.reduce((n,cell)=>n+cell.seen,0)).toBe(50_010);
   expect(report.cells.reduce((n,cell)=>n+cell.closeCount,0)).toBe(3);

   phase='analyze';
   if(!dense||!nativeSettings)throw new Error('Searched Carry dense declaration unavailable');
   const {statement,compiled}=dense;
   const settings=nativeSettings;
   const analyzed=sql`explain(analyze,buffers,verbose,settings,timing off,format json) ${statement}`;
   const wrapped=dialect.sqlToQuery(analyzed);
   if(!isDeepStrictEqual(dialect.sqlToQuery(statement),compiled)||wrapped.sql!==EXPLAIN_PREFIX+compiled.sql||
      !isDeepStrictEqual(wrapped.params,compiled.params))throw new Error('Searched Carry diagnostic altered the dense declaration');
   const analyzeEnd=cellEnd();
   const diagnostic:NonNullable<Receipt['analyze']>={
    nativeStarted:false,declarationSha256:hash(compiled.sql),parameterCount:compiled.params.length,
    settingsSha256:hash(JSON.stringify(settings)),settings,
   };
   report.analyze=diagnostic;
   await inApp(fixture.ctx,fixture,db,analyzeEnd,async(tx,lane)=>{
    await assertAiPresentationPrincipalTx(guardedTx(tx,lane,query=>lane.run(()=>tx.execute(query))),fixture.ctx);
    const analyzeStarted=performance.now();
    const rows=await lane.run(()=>{
     const query=tx.execute<{'QUERY PLAN':unknown}>(analyzed);
     diagnostic.nativeStarted=true;
     return query;
    }).finally(()=>{
     if(diagnostic.nativeStarted)diagnostic.nativeMs=performance.now()-analyzeStarted;
    });
    if(rows.length!==1||Object.keys(rows[0]).join(',')!=='QUERY PLAN')throw new Error('Searched Carry diagnostic requires one native plan row');
    diagnostic.plan=summarizePlan(rows[0]['QUERY PLAN']);
    requireRoom(analyzeEnd,0,signal);
   });
   expect(identities).toHaveLength(4);
  } catch(error) {
   remember(error);
  }
  phase='settlement';
  try {
   await proveIdle();
  } catch(error) {
   report.settlement='REFUSED';
   if(failure) {
    report.secondarySettlementFailure=failureFact(error,phase);
   } else remember(error);
  }
  phase='receipt';
  if(!failure) {
   try {
    requireRoom(caseEnd,0,signal);
    report.status='COMPLETE';
    store();
    requireRoom(caseEnd,0,signal);
   } catch(error) {
    report.status='INCOMPLETE';
    remember(error);
   }
  }
  if(failure) {
   try { store(); } catch { /* The original failure remains primary. */ }
   // Keep the primary native error private. Vitest's public log receives only closed facts.
   const {fact}=failure;
   throw new Error(['Searched Carry qualification failed',fact.phase,fact.kind,fact.sqlState].filter(Boolean).join(' / '));
  }
 }

 const running=runCourse();
 completion=running.then(()=>undefined,()=>undefined);
 await running;
},CASE_MS);
