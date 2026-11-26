/** ADR 0181 planning cost (26 November 2026): the large combined read statements sent as named prepared statements
 * (db/prepared-read.ts) return the same rows, in the same order, and stop paying their planning on every call.
 *
 * Staging's pg_stat_statements (24 to 26 November) showed these statements planned on every call (plans = calls): the
 * account task statement (Today and Approvals, `with task_caller as materialized`), the Before payroll statement
 * (`cut_off_row`), the request preamble (the carrier's identity statement with `request_preamble`), the recruitment
 * to-dos (`Approval steps are tenant-wide`) and the payroll freshness reads (`max(d.occurred_at)`). drizzle-orm sends
 * every statement through postgres.js `unsafe`, whose default is an unnamed statement, so PostgreSQL planned each call.
 *
 * On the fictional 71-company / 1,000-employment fixture (test/helpers/ai-centre-scale-fixture.ts), for a group
 * administrator, a manager and an employee, each statement is captured from a real Today render (or its reader) and
 * replayed on one application connection of its own, in a rolled-back read-only snapshot with the render's own identity:
 *  - unnamed:  as before, every call parsed and planned; planning and execution split by EXPLAIN (ANALYZE, SUMMARY);
 *  - prepared: the same text and parameters as a named statement, as executePrepared sends it, with PostgreSQL's own
 *              plan choice (plan_cache_mode auto): five plans with the call's values, then a generic plan when it is
 *              estimated no dearer; pg_prepared_statements says which it used;
 *  - generic:  the same statement with plan_cache_mode=force_generic_plan, to show the generic plan's own cost.
 * Every call of every mode must return the rows of the first unnamed call, in the same order, and what the
 * application now sends (the account task statement's generic plan, every other statement prepared) must be no slower.
 * Each measurement is printed as one `PLANNING_COST {json}` line for the release notes; the Today and Approvals renders
 * are also compared whole with AIHR_PREPARED_READS off and on (`PLANNING_COST_RENDER`). All names are invented. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createElement} from 'react';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,pathname:'/',cookies:{} as Record<string,string>}));
vi.mock('next/font/google',()=>{const font=()=>({variable:'fixture-font'});return {Plus_Jakarta_Sans:font,Geist_Mono:font,DM_Mono:font};});
vi.mock('next/font/local',()=>({default:()=>({variable:'fixture-local-font'})}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers({'x-pathname':state.pathname}),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next-intl/server',()=>{
 const translator=(namespace?:string)=>{
  const t=(key:string,values?:Record<string,unknown>)=>`${namespace?namespace+'.':''}${key}${values?JSON.stringify(values,(_k,v)=>typeof v==='bigint'?String(v):v):''}`;
  return Object.assign(t,{rich:t,markup:t,raw:(key:string)=>key,has:()=>true});
 };
 return {
  getLocale:async()=>'en',getTimeZone:async()=>'Asia/Kuala_Lumpur',getNow:async()=>new Date(),getMessages:async()=>({}),
  getTranslations:async(arg?:string|{namespace?:string})=>translator(typeof arg==='string'?arg:arg?.namespace),
  getFormatter:async()=>({dateTime:(value:unknown)=>new Date(value as string).toISOString(),number:(value:unknown)=>String(value),
   relativeTime:(value:unknown)=>String(value),list:(value:unknown[])=>value.join(', '),dateTimeRange:(a:unknown,b:unknown)=>`${String(a)}–${String(b)}`}),
 };
});
vi.mock('../lib/demo-mode',async importOriginal=>({...await importOriginal<typeof import('../lib/demo-mode')>(),
 demoSwitcherEnabled:()=>false,isDemoDeployment:()=>false}));
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import type {SessionContext} from '../db/client';
import {applicationDatabaseUrl} from '../db/pooling';
import {preparedReadCounts} from '../db/prepared-read';
import * as schema from '../db/schema';
import {MODULE_CATALOG} from '../packs/catalog';
import {resignationRuntimeKey} from '../lib/resignation-runtime-proof';
import {withRequestReadScope} from '../lib/request-read-scope';
import Layout from '../app/layout';
import HomePage from '../app/page';
import ApprovalsPage from '../app/approvals/page';
import {payrollChangedCompanies} from '../core/loops/payroll-freshness';
import {recruitmentTodos} from '../packs/recruitment/tasks';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {isIdentityStatement,observeStatements,type Captured} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

/** The statements this change sends prepared, by the label executePrepared counts them under. */
const TARGETS={
 'request-preamble':(text:string)=>isIdentityStatement(text)&&/\brequest_preamble\b/.test(text),
 'account-tasks':(text:string)=>/^with task_caller as materialized\b/i.test(text.trim()),
 'before-payroll':(text:string)=>/^select jsonb_build_object\(/i.test(text.trim())&&/\)\s+as bundle\s*$/i.test(text),
 'recruitment-personal-todos':(text:string)=>/-- Approval steps are tenant-wide/.test(text),
 'payroll-freshness-runs':(text:string)=>/^select b\.company_id,max\(d\.occurred_at\) as at from public\.domain_event d/i.test(text.trim()),
 'payroll-freshness-files':(text:string)=>/^select d\.payload->>'companyId' as company_id,max\(d\.occurred_at\) as at/i.test(text.trim()),
} as const;
type Target=keyof typeof TARGETS;
const PERSONAS=['group','manager','employee'] as const;
type Persona=(typeof PERSONAS)[number]|'manager2'|'employee2';
/** Calls per mode. The prepared mode needs more than five on one connection to reach PostgreSQL's plan choice. */
const UNNAMED_CALLS=8,PREPARED_CALLS=12,GENERIC_CALLS=6,EXPLAINS=3;
/** Every measurement, written to the hosted focused run's evidence directory when it has one. */
const evidence:unknown[]=[];

let b:Base,fixture:ScaleFixture;
let personas:Record<Persona,SessionContext>;
beforeAll(async()=>{
 // Staging's setting: Today's carriers and the default read join (ADR 0181 package 1.1).
 process.env.AIHR_DEFAULT_REQUEST_READ_JOIN='on';
 process.env.AIHR_VIEWER_MENU_CACHE='off';
 await migrateTestDb();await resetDb();b=await seedBase();
 // Every pack module on, as on staging: each Today section and the bell's recruitment to-dos are read. The Approvals
 // resignation owner signs a runtime proof: a fictional key and its verifier, as the resignation tests set them.
 vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://planning.example.test');vi.stubEnv('AUTH_SESSION_KEY','7'.repeat(64));
 await owner.db.execute(sql`delete from app.resignation_runtime_state`);await owner.db.execute(sql`delete from app.resignation_runtime_verifier`);
 await owner.db.execute(sql`insert into app.resignation_runtime_verifier(singleton,secret) values(true,${resignationRuntimeKey('7'.repeat(64))})`);
 await owner.db.insert(schema.tenantModule).values(MODULE_CATALOG.filter(m=>!m.isCore&&m.packBacked).map(m=>({tenantId:b.tenantId,moduleCode:m.code,status:'active' as const}))).onConflictDoNothing();
 fixture=await buildScaleFixture(b,{employments:1000});
 const base=await entitledCtx(b,['hr_admin']);
 const own=async(employmentId:string,roles:string[]):Promise<SessionContext>=>{
  const [row]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(sql`${schema.employment.id}=${employmentId}::uuid`);
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:row.personId}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values(roles.map(role=>({tenantId:b.tenantId,appUserId:u.id,companyId:null,role:role as 'employee'})));
  return {...base,userId:u.id,personId:row.personId,roles,grants:roles.map(role=>({role,companyId:null}))};
 };
 personas={group:fixture.personas.group,
  manager:await own(fixture.activeEmploymentIds[11],['manager']),manager2:await own(fixture.activeEmploymentIds[12],['manager']),
  employee:await own(fixture.activeEmploymentIds[23],['employee']),employee2:await own(fixture.activeEmploymentIds[24],['employee'])};
 // The payroll freshness reads need payroll run and file events: each fixture payroll run processed (and some closed)
 // in the last ten days, and statutory and bank files for a third of the companies. Fictional, written as the owner.
 const batches=await owner.db.select({id:schema.payrollBatch.id,companyId:schema.payrollBatch.companyId}).from(schema.payrollBatch)
  .where(sql`${schema.payrollBatch.tenantId}=${b.tenantId}::uuid`).orderBy(schema.payrollBatch.id);
 expect(batches.length).toBeGreaterThan(0);
 const now=Date.now(),events:(typeof schema.domainEvent.$inferInsert)[]=[];
 batches.forEach((batch,i)=>{
  events.push({tenantId:b.tenantId,aggregateType:'payroll-batch',aggregateId:batch.id,eventType:'payroll-batch.processed',actorType:'system',payload:{n:i},occurredAt:new Date(now-(i%10+1)*86_400_000)});
  if(i%3===0)events.push({tenantId:b.tenantId,aggregateType:'payroll-batch',aggregateId:batch.id,eventType:'payroll-batch.closed',actorType:'system',payload:{n:i},occurredAt:new Date(now-(i%7+1)*3_600_000)});
 });
 fixture.companyIds.forEach((companyId,i)=>{if(i%3===0)events.push({tenantId:b.tenantId,aggregateType:'statutory-report',aggregateId:randomUUID(),
  eventType:i%2?'statutory-report.generated':'bank-payment-file.generated',actorType:'system',payload:{companyId},occurredAt:new Date(now-(i%9+1)*7_200_000)});});
 await owner.db.insert(schema.domainEvent).values(events);
},300_000);
afterAll(async()=>{
 vi.unstubAllEnvs();
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'planning-cost-prepared-reads.json'),
  JSON.stringify({kind:'PLANNING_COST_PREPARED_READS',fictional:true,source:process.env.AIHR_CI_HEAD??null,measurements:evidence},null,1));
 delete process.env.AIHR_DEFAULT_REQUEST_READ_JOIN;delete process.env.AIHR_VIEWER_MENU_CACHE;delete process.env.AIHR_PREPARED_READS;await closeAll();});

const normalize=(key:string,value:unknown)=>key==='claimPreviewRevision'&&typeof value==='string'?'<revision>':value;
/** One Today render (the root layout and Home page), or an Approvals render, as one request, its statements captured. */
async function renderToday(persona:Persona,route:'today'|'approvals'='today'){
 state.session=personas[persona];state.pathname=route==='today'?'/':'/approvals';state.cookies={};
 const page=route==='today'?createElement(HomePage,{searchParams:Promise.resolve({})}):createElement(ApprovalsPage,{searchParams:Promise.resolve({})});
 const run=()=>serverTreeSnapshot(createElement(Layout,{children:page}),normalize)
  .catch((error:unknown)=>{const digest=(error as {digest?:unknown})?.digest;if(typeof digest==='string'&&digest.startsWith('NEXT_'))return {redirect:digest};throw error;});
 return withRequestReadScope({},()=>observeStatements(run));
}
/** The payroll freshness reads for every company the loops know, with files, as the 15-minute tick asks. */
async function readFreshness(){
 const since=new Map(fixture.companyIds.map(id=>[id,new Date(Date.now()-30*86_400_000)] as const));
 return observeStatements(()=>payrollChangedCompanies(personas.group,{companies:fixture.companyIds,since,files:true}));
}

type Pair={target:Target;persona:Persona;setup:Captured|null;statement:Captured};
/** Each target statement in `statements` with the identity statement of its transaction (none for the preamble, which
 * is that identity statement). The first occurrence of each target. */
function pairs(persona:Persona,statements:readonly Captured[]):Pair[]{
 const out:Pair[]=[];
 statements.forEach((statement,index)=>{
  for(const target of Object.keys(TARGETS) as Target[]){
   if(!TARGETS[target](statement.sql)||out.some(pair=>pair.target===target))continue;
   const setup=target==='request-preamble'?null:[...statements.slice(0,index)].reverse().find(s=>isIdentityStatement(s.sql))??null;
   out.push({target,persona,setup,statement});
  }
 });
 return out;
}

const plain=(rows:unknown)=>JSON.parse(JSON.stringify(rows,(_key,value)=>typeof value==='bigint'?'N:'+value.toString():value)) as unknown;
const median=(values:readonly number[])=>{const sorted=[...values].sort((x,y)=>x-y);return sorted.length?Math.round(sorted[Math.floor(sorted.length/2)]*100)/100:null;};
/** One call in its own rolled-back read-only snapshot, after the render's identity statement. */
async function call(connection:postgres.Sql,pair:Pair,prepare:boolean,explain?:'analyze'|'generic'):Promise<{rows:unknown;ms:number}>{
 await connection.unsafe('begin isolation level repeatable read read only');
 try{
  if(pair.setup)await connection.unsafe(pair.setup.sql,pair.setup.params as never[]);
  const text=explain==='analyze'?`explain (analyze, summary, format json) ${pair.statement.sql}`
   :explain==='generic'?`explain (generic_plan, summary, format json) ${pair.statement.sql}`:pair.statement.sql;
  const started=performance.now();
  const rows=await connection.unsafe(text,explain==='generic'?[]:pair.statement.params as never[],{prepare});
  return {rows:plain([...rows]),ms:performance.now()-started};
 }finally{await connection.unsafe('rollback');}
}
type Plan={'Planning Time':number;'Execution Time'?:number};
const planOf=(rows:unknown)=>((rows as Record<string,unknown>[])[0]['QUERY PLAN'] as Plan[])[0];

/** The measurement of one statement for one persona on one application connection of its own (the application role,
 * so row security applies; a new backend, so no plan or prepared statement of the renders is reused). */
async function measure(pair:Pair){
 const connection=postgres(applicationDatabaseUrl(process.env).url,{max:1,onnotice:()=>{}});
 // drizzle's own driver settings (its date and JSON parameter serializers), as the application's client has them.
 drizzle(connection);
 try{
  // Warm the backend's catalog caches (a pool's backends live for hours) without preparing anything.
  for(let i=0;i<2;i++)await call(connection,pair,false);
  const unnamed=[];for(let i=0;i<UNNAMED_CALLS;i++)unnamed.push(await call(connection,pair,false));
  const explained=[];for(let i=0;i<EXPLAINS;i++)explained.push(planOf((await call(connection,pair,false,'analyze')).rows));
  // PostgreSQL 16's EXPLAIN (GENERIC_PLAN): the one-time cost of building the generic plan on a server connection.
  let genericPlanningMs:number|null=null;
  try{genericPlanningMs=Math.round(planOf((await call(connection,pair,false,'generic')).rows)['Planning Time']*100)/100;}catch{genericPlanningMs=null;}
  // Plan cache memory this backend holds for the prepared statement (the application role may not read it everywhere).
  const memory=async()=>{try{const [row]=await connection.unsafe<{bytes:string}[]>(`select coalesce(sum(total_bytes),0)::text as bytes from pg_backend_memory_contexts
   where name in ('CachedPlanSource','CachedPlanQuery','CachedPlan')`);return Number(row.bytes);}catch{return null;}};
  const memoryBefore=await memory();
  const prepared=[];for(let i=0;i<PREPARED_CALLS;i++)prepared.push(await call(connection,pair,true));
  const memoryAfter=await memory();
  const counters=async()=>{
   const [row]=await connection.unsafe<{generic_plans:string;custom_plans:string}[]>('select generic_plans::text,custom_plans::text from pg_prepared_statements where statement=$1',[pair.statement.sql]);
   return row?{generic:Number(row.generic_plans),custom:Number(row.custom_plans)}:null;
  };
  const auto=await counters();
  await connection.unsafe(`set plan_cache_mode = force_generic_plan`);
  const generic=[];
  try{for(let i=0;i<GENERIC_CALLS;i++)generic.push(await call(connection,pair,true));}
  finally{await connection.unsafe(`reset plan_cache_mode`);}
  const forced=await counters();
  const expected=unnamed[0].rows;
  const differing=[...unnamed,...prepared,...generic].map((result,index)=>JSON.stringify(result.rows)===JSON.stringify(expected)?null:index).filter(index=>index!==null);
  const row={target:pair.target,persona:pair.persona,parameters:pair.statement.params.length,textLength:pair.statement.sql.length,
   rows:Array.isArray(expected)?expected.length:null,resultBytes:JSON.stringify(expected).length,
   unnamed:{wallMs:median(unnamed.map(result=>result.ms)),planningMs:median(explained.map(plan=>plan['Planning Time'])),executionMs:median(explained.map(plan=>plan['Execution Time']??0))},
   prepared:{firstFiveMs:median(prepared.slice(0,5).map(result=>result.ms)),laterMs:median(prepared.slice(5).map(result=>result.ms)),plans:auto,
    cachedPlanBytes:memoryBefore===null||memoryAfter===null?null:memoryAfter-memoryBefore},
   generic:{wallMs:median(generic.map(result=>result.ms)),planningOnceMs:genericPlanningMs,plans:forced},differing};
 console.log('PLANNING_COST '+JSON.stringify(row));
  evidence.push(row);
  return {...row,expected};
 }finally{await connection.end();}
}

describe('planning cost: named prepared statements for the large combined reads',()=>{
 const captured=new Map<Persona,Pair[]>();
 it('captures each target statement from a Today render or its reader, with one statement shape per role',async()=>{
  for(const persona of [...PERSONAS,'manager2','employee2'] as const){
   await renderToday(persona);
   const observed=await renderToday(persona);
   const found=pairs(persona,observed.statements);
   // The recruitment to-dos are the bell's (a frame read); if the render did not send them, their reader does.
   if(!found.some(pair=>pair.target==='recruitment-personal-todos')){
    const todos=await observeStatements(()=>recruitmentTodos(personas[persona],undefined,{now:new Date()}));
    found.push(...pairs(persona,todos.statements).filter(pair=>pair.target==='recruitment-personal-todos'));
   }
   if(persona==='group')found.push(...pairs(persona,(await readFreshness()).statements));
   captured.set(persona,found);
   console.log('PLANNING_COST_CAPTURE '+JSON.stringify({persona,targets:found.map(pair=>({target:pair.target,parameters:pair.statement.params.length,setup:!!pair.setup}))}));
  }
  // Every target is captured for some persona, and Today's preamble and task statement for each persona.
  const all=new Set([...captured.values()].flat().map(pair=>pair.target));
  expect([...all].sort()).toEqual(Object.keys(TARGETS).sort());
  for(const persona of PERSONAS){
   const targets=captured.get(persona)!.map(pair=>pair.target);
   expect(targets,persona).toContain('request-preamble');
   expect(targets,persona).toContain('account-tasks');
  }
  // One statement shape per role, not per login: two managers (and two employees) send the same texts, so a server
  // connection keeps one prepared statement per role and variant.
  for(const [first,second] of [['manager','manager2'],['employee','employee2']] as const){
   const texts=(persona:Persona)=>new Map(captured.get(persona)!.map(pair=>[pair.target,pair.statement.sql]));
   const a=texts(first),c=texts(second);
   for(const [target,text] of a)if(c.has(target))expect(c.get(target)===text,`${first}/${second} ${target}`).toBe(true);
  }
  // The readers went through executePrepared, prepared.
  const counts=preparedReadCounts();
  for(const target of Object.keys(TARGETS))expect(counts.get(target)?.prepared??0,target).toBeGreaterThan(0);
 },600_000);

 it.each(PERSONAS)('returns identical rows in identical order unnamed, prepared and generic, and reports planning, for %s',async persona=>{
  const found=captured.get(persona)!;
  expect(found.length).toBeGreaterThan(0);
  for(const pair of found){
   const measured=await measure(pair);
   expect(measured.differing,`${persona} ${pair.target}`).toEqual([]);
   // What the application now sends is no slower than before (1 ms or 10% of noise): the account task statement with its
   // generic plan from the first call (genericPlanSettingsStatement), every other statement prepared in auto mode, after
   // its first five calls on a connection.
   const after=pair.target==='account-tasks'?measured.generic.wallMs!:measured.prepared.laterMs!;
   expect(after,`${persona} ${pair.target} wall after vs before`).toBeLessThanOrEqual(measured.unnamed.wallMs!*1.1+1);
   // The fixture has no recruitment work (nor had staging: the statement ran in 0.2 ms); every other read returns rows.
   if(pair.target!=='recruitment-personal-todos')expect(measured.rows,`${persona} ${pair.target} returned rows`).toBeGreaterThan(0);
  }
 },900_000);

 it.each([...PERSONAS.map(persona=>['today',persona] as const),['approvals','group'] as const,['approvals','manager'] as const])
 ('renders %s identically with prepared reads off and on, for %s',async(route,persona)=>{
  const off:number[]=[],on:number[]=[];let first:unknown;
  for(let round=0;round<6;round++){
   for(const mode of ['off','on'] as const){
    process.env.AIHR_PREPARED_READS=mode;
    const rendered=await renderToday(persona,route);
    first??=plain(rendered.result);
    expect(JSON.stringify(plain(rendered.result))===JSON.stringify(first),`${route} ${persona} ${mode} round ${round}`).toBe(true);
    // The first round fills process and connection caches; only later rounds are timed.
    if(round>0)(mode==='off'?off:on).push(rendered.ms);
   }
  }
  delete process.env.AIHR_PREPARED_READS;
  expect(JSON.stringify(first).length).toBeGreaterThan(500);
  const row={route,persona,offMs:median(off),onMs:median(on),off:off.map(Math.round),on:on.map(Math.round)};
  console.log('PLANNING_COST_RENDER '+JSON.stringify(row));
  evidence.push({render:row});
 },600_000);
});
