/** ADR 0181 plan packages 1.1, 1.2, 1.3 and 1.5: route read budgets for the app frame, Home, Approvals and Personnel.
 *
 * Each route is rendered as one server render (lib/request-read-scope.ts withRequestReadScope, server components
 * resolved by test/helpers/server-tree-snapshot.ts) on the fictional 71-company / 1,000-employment group fixture
 * (test/helpers/ai-centre-scale-fixture.ts), for the native roles, and its statements and transactions are counted
 * (test/helpers/statement-observer.ts). It proves:
 *  - equivalence: every route renders identical output with the read join on (AIHR_DEFAULT_REQUEST_READ_JOIN=on,
 *    packages 1.1 and 1.2) with one carrier and with a pool of 2 and 3 (AIHR_DEFAULT_REQUEST_READ_CARRIERS), off (the
 *    production default) and with no shared snapshot at all, for every role;
 *  - pool bound: with a pool of N, no identity ever holds more than N+1 carriers at once (the pool, plus the page's own
 *    beside a frame that holds the whole pool), and a pooled render never costs more transactions than the join off;
 *  - cost: the default join never costs more transactions than reads without it, and the frame reads in at most
 *    FRAME_TRANSACTIONS transactions;
 *  - scale: "All companies" of 71 companies costs no more transactions or statements than one company, for a group
 *    administrator (company switcher) and for company-by-company grants against a single-company administrator;
 *  - budgets: no route exceeds its recorded budget (BUDGETS). Budgets only go down; raising one needs an ADR note;
 *  - no write on page load (package 1.3): a frame render sends no INSERT, UPDATE or DELETE and takes no exclusive
 *    advisory lock, for any role; and the inventory of frame owners that fall back to their own transaction.
 *  - wall time: each route rendered in interleaved rounds in every mode, printed as `ROUTE_WALL {json}` (median and
 *    spread of `ms` per mode), to compare the pool sizes against the join off. The audit log (/admin/audit) and a
 *    processed payroll run of the work-holding company (/payroll/[batchId]) are measured the same way for a group
 *    administrator, after the budget checks (the run is opened for them), with identical output at a pool of 3.
 * Every measurement is printed as one `ROUTE_BUDGET {json}` line for the release notes. All names are invented. */
import {randomUUID} from 'node:crypto';
import {createElement,type ReactNode} from 'react';
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
// A real deployment: no dev identity switcher (its principal list is a dev/demo-only pool read, ordered by role and name
// with ties, so its order can differ between two renders) and not the gated demo.
vi.mock('../lib/demo-mode',async importOriginal=>({...await importOriginal<typeof import('../lib/demo-mode')>(),
 demoSwitcherEnabled:()=>false,isDemoDeployment:()=>false}));
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import type {SessionContext} from '../db/client';
import {requestScopedReadStats,withIndependentTransactions,withoutDefaultRequestJoin} from '../db/client';
import * as schema from '../db/schema';
import {withRequestReadScope} from '../lib/request-read-scope';
import Layout from '../app/layout';
import HomePage from '../app/page';
import ApprovalsPage from '../app/approvals/page';
import PersonnelPage from '../app/personnel/page';
import AuditPage from '../app/admin/audit/page';
import PayrollLayout from '../app/payroll/layout';
import PayrollRunPage from '../app/payroll/[batchId]/page';
import {createBatch,generatePayslips} from '../core/payroll';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {explainStatements,observeStatements,type Captured} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

/** The frame (app/layout.tsx with no page) reads in at most this many transactions for every role (package 1.2): its
 * one pass, plus, for an administrator with pending profile changes in view, the Profile Changes owner's locked
 * decision check, which takes the shared Access and profile-policy barriers and so keeps its own transaction. */
const FRAME_TRANSACTIONS=2;
/** Recorded budgets per route (transactions, statements) at "All companies" on the 71-company fixture, default join on.
 * Budgets only go down. Raising one needs an ADR note (docs/plans/2026-11-24-database-read-cost-phase-0-1.md 1.5). */
const BUDGETS:Record<BudgetRoute,Partial<Record<'group'|'multi'|'single'|'manager'|'employee'|'payroll',{transactions:number;statements:number}>>>={
 frame:{group:{transactions:2,statements:21},multi:{transactions:2,statements:21},single:{transactions:1,statements:9},
  manager:{transactions:1,statements:8},employee:{transactions:1,statements:8},payroll:{transactions:1,statements:8}},
 // Home's administrator Today keeps its payroll-history and setting owners in their own transactions (barriers).
 home:{group:{transactions:16,statements:121},multi:{transactions:16,statements:121},single:{transactions:14,statements:81},
  manager:{transactions:2,statements:28},employee:{transactions:1,statements:51},payroll:{transactions:1,statements:51}},
 // Recorded before package 1.4 (set-based leave breakdowns); lower these once it is on main. Employees are redirected.
 approvals:{group:{transactions:8,statements:47},multi:{transactions:8,statements:47},single:{transactions:7,statements:35},
  manager:{transactions:7,statements:31}},
 personnel:{group:{transactions:3,statements:28},multi:{transactions:3,statements:28},single:{transactions:2,statements:16},
  manager:{transactions:3,statements:20},employee:{transactions:3,statements:20},payroll:{transactions:3,statements:20}},
};

type BudgetRoute='frame'|'home'|'approvals'|'personnel';
/** Measured for wall time and equivalence only (their budgets are not recorded yet: test/read-cost-ratchets). */
type WallRoute='audit'|'payrollRun';
type Route=BudgetRoute|WallRoute;
/** The processed payroll run /payroll/[batchId] shows (opened in the wall-time describe below). */
let payrollRunId='';
const ROUTES:Record<Route,{pathname:()=>string;page:()=>ReactNode}>={
 frame:{pathname:()=>'/personnel',page:()=>null},
 home:{pathname:()=>'/',page:()=>createElement(HomePage,{searchParams:Promise.resolve({})})},
 approvals:{pathname:()=>'/approvals',page:()=>createElement(ApprovalsPage,{searchParams:Promise.resolve({})})},
 personnel:{pathname:()=>'/personnel',page:()=>createElement(PersonnelPage,{searchParams:Promise.resolve({})})},
 audit:{pathname:()=>'/admin/audit',page:()=>createElement(AuditPage,{searchParams:Promise.resolve({})})},
 payrollRun:{pathname:()=>`/payroll/${payrollRunId}`,page:()=>createElement(PayrollLayout,{children:createElement(PayrollRunPage,
  {params:Promise.resolve({batchId:payrollRunId}),searchParams:Promise.resolve({})})})},
};
const BUDGET_ROUTES:BudgetRoute[]=['frame','home','approvals','personnel'];

let b:Base,fixture:ScaleFixture;
let personas:Record<'group'|'multi'|'single'|'manager'|'employee'|'payroll'|'base',SessionContext>;
/** The fixture's work-holding company (its base company): the pending profile changes, payroll runs and checks of the
 * fixture are there, so a one-company view of it shows every kind of pending work the 71-company view shows. Cost then
 * differs only by the number of companies, which is what the scale check compares. */
let workCompanyId:string;
beforeAll(async()=>{
 // The read join is opt-in (production default off); `default` below measures it switched on.
 process.env.AIHR_DEFAULT_REQUEST_READ_JOIN='on';
 // The budgets are the uncached frame's (its worst case, and independent of render order). The cached viewer menu
 // (ADR 0181 Phase 3, app/viewer-menu-profile.ts) is measured by test/viewer-menu-profile.test.ts.
 process.env.AIHR_VIEWER_MENU_CACHE='off';
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 const base=await entitledCtx(b,['hr_admin']);
 /** A login for one of the fixture's own employments, with these roles. */
 const own=async(employmentId:string,roles:string[],companyId:string|null=null):Promise<SessionContext>=>{
  const [row]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(sql`${schema.employment.id}=${employmentId}::uuid`);
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:row.personId}).returning({id:schema.appUser.id});
  const grants=roles.map(role=>({role,companyId}));
  await owner.db.insert(schema.roleAssignment).values(grants.map(g=>({tenantId:b.tenantId,appUserId:u.id,companyId:g.companyId,role:g.role as 'employee'})));
  return {...base,userId:u.id,personId:row.personId,roles,grants};
 };
 personas={...fixture.personas,
  manager:await own(fixture.activeEmploymentIds[11],['manager']),
  employee:await own(fixture.activeEmploymentIds[23],['employee']),
  payroll:await own(fixture.activeEmploymentIds[37],['employee','payroll_partner']),
  base:undefined as unknown as SessionContext};
 workCompanyId=b.companyId;
 // A company HR administrator of the work-holding company only (with an own employment there, like the fixture's
 // administrators), against company-by-company grants on all 71.
 const [inBase]=await owner.db.select({id:schema.employment.id}).from(schema.employment)
  .where(sql`${schema.employment.companyId}=${workCompanyId}::uuid and ${schema.employment.terminatedOn} is null and ${schema.employment.id}<>all(${sql.raw(`array[${[11,23,37].map(i=>`'${fixture.activeEmploymentIds[i]}'`).join(',')}]`)}::uuid[])`)
  .orderBy(sql`${schema.employment.employeeCode} desc`).limit(1);
 personas.base=await own(inBase.id,['hr_admin'],workCompanyId);
},240_000);
afterAll(async()=>{delete process.env.AIHR_DEFAULT_REQUEST_READ_JOIN;delete process.env.AIHR_VIEWER_MENU_CACHE;await closeAll();});

const normalize=(key:string,value:unknown)=>key==='claimPreviewRevision'&&typeof value==='string'?'<revision>':value;
const WRITE=/^\s*(insert\s+into|update\s+("?[a-z_][a-z0-9_.]*"?\.)?"?[a-z_][a-z0-9_]*"?\s+set\b|delete\s+from)|\bpg_(try_)?advisory_xact_lock\s*\(/i;

/** default: the read join on (AIHR_DEFAULT_REQUEST_READ_JOIN=on: package 1.1 and the frame pass in one snapshot), one
 * carrier per identity. pool2, pool3: the read join on with a bounded pool of 2 or 3 carriers per identity
 * (AIHR_DEFAULT_REQUEST_READ_CARRIERS).
 * without: the production default, off (only Home's, Today's and the shell approval summary's explicit snapshots).
 * independent: no shared snapshot at all, every owner in its own transaction, as before shared snapshots existed. */
type Mode='default'|'pool2'|'pool3'|'without'|'independent';
const POOL:Partial<Record<Mode,string>>={pool2:'2',pool3:'3'};
type Measured={route:Route;persona:string;scope:'all'|'one';mode:Mode;transactions:number;statements:number;ms:number;
 output:unknown;captured:Captured[];refused:Record<string,number>;fallbacks:number;staleSkips:number;peakCarriers:number};
async function render(route:Route,persona:keyof typeof personas,scope:'all'|'one',mode:Mode):Promise<Measured>{
 state.session=personas[persona];state.pathname=ROUTES[route].pathname();
 state.cookies=scope==='one'?{company_scope:workCompanyId}:{};
 const requestScope={};
 // A redirect (a role that may not open the route) is the render's output, recorded by its digest.
 const run=()=>serverTreeSnapshot(createElement(Layout,{children:ROUTES[route].page()}),normalize)
  .catch((error:unknown)=>{const digest=(error as {digest?:unknown})?.digest;if(typeof digest==='string'&&digest.startsWith('NEXT_'))return {redirect:digest};throw error;});
 const pool=POOL[mode];
 if(pool)process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS=pool;else delete process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS;
 let observed:{result:unknown;ms:number;statements:Captured[];transactions:number};
 try{
  observed=await withRequestReadScope(requestScope,()=>observeStatements(()=>mode==='without'?withoutDefaultRequestJoin(run):mode==='independent'?withIndependentTransactions(run):run()));
 }finally{delete process.env.AIHR_DEFAULT_REQUEST_READ_CARRIERS;}
 const stats=await requestScopedReadStats(requestScope);
 const refused:Record<string,number>={},failures:Record<string,number>={};
 for(const session of stats){
  for(const [reason,count] of Object.entries(session.refused))refused[reason]=(refused[reason]??0)+count;
  for(const [code,count] of Object.entries(session.failures))failures[code]=(failures[code]??0)+count;
 }
 // Statement text only (code, never parameters): which owners took a barrier in their own transaction.
 // Each barrier with the next statements of its own transaction, so the owner can be named.
 const text=(statement:Captured)=>statement.sql.replace(/\s+/g,' ').slice(0,200);
 const barriers=observed.statements.flatMap((statement,index)=>{
  if(!/pg_(try_)?advisory/i.test(statement.sql))return [];
  const after:string[]=[];
  for(const next of observed.statements.slice(index+1,index+4)){if(/^select set_config\('app\.tenant_id'/i.test(next.sql.trim()))break;after.push(text(next));}
  return [{barrier:text(statement),then:after}];
 });
 const measured={route,persona,scope,mode,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms),output:observed.result,
  captured:observed.statements,refused,fallbacks:stats.reduce((sum,session)=>sum+session.fallbacks,0),staleSkips:stats.reduce((sum,session)=>sum+session.staleSkips,0),
  peakCarriers:Math.max(0,...stats.map(session=>session.peakCarriers))};
 console.log('ROUTE_BUDGET '+JSON.stringify({route,persona,scope,mode,transactions:measured.transactions,statements:measured.statements,
  ms:measured.ms,refused,failures,fallbacks:measured.fallbacks,staleSkips:measured.staleSkips,peakCarriers:measured.peakCarriers,identities:stats.length,barriers}));
 return measured;
}

/** Database time of a measured render: its read statements replayed under EXPLAIN ANALYZE in one rolled-back
 * transaction (planning and execution summed). Phase 1 changes how many transactions and round trips a page pays;
 * the per-statement cost of definer functions is Phase 2/3's, and this figure keeps that visible. */
async function statementTime(measured:Measured){
 const explained=await explainStatements(measured.captured);
 const sum=(pick:(row:(typeof explained)[number])=>number|null|undefined)=>Math.round(explained.reduce((total,row)=>total+(pick(row)??0),0));
 const slowest=[...explained].filter(row=>row.executionMs!==null).sort((x,y)=>(y.executionMs!+(y.planningMs??0))-(x.executionMs!+(x.planningMs??0))).slice(0,8)
  .map(row=>({ms:Math.round(row.executionMs!+(row.planningMs??0)),sql:row.sql.replace(/\s+/g,' ').slice(0,140)}));
 const row={route:measured.route,persona:measured.persona,scope:measured.scope,mode:measured.mode,executionMs:sum(row=>row.executionMs),
  planningMs:sum(row=>row.planningMs),replayed:explained.filter(row=>row.executionMs!==null).length,slowest,
  errors:explained.filter(row=>row.error&&row.error!=='not a read').map(row=>({sql:row.sql.replace(/\s+/g,' ').slice(0,200),error:row.error!.slice(0,160)}))};
 console.log('ROUTE_STATEMENT_TIME '+JSON.stringify(row));
 return row;
}

/** The first place two snapshots differ, as a path and both values (vitest truncates deep trees in its diff). */
function firstDifference(a:unknown,b:unknown,path='$'):string|null{
 if(Object.is(a,b))return null;
 if(typeof a!=='object'||typeof b!=='object'||a===null||b===null||Array.isArray(a)!==Array.isArray(b))
  return `${path}: ${JSON.stringify(a)?.slice(0,300)} !== ${JSON.stringify(b)?.slice(0,300)}`;
 const keys=[...new Set([...Object.keys(a as object),...Object.keys(b as object)])];
 for(const key of keys){const found=firstDifference((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],`${path}.${key}`);if(found)return found;}
 return null;
}

const ROLES=['group','multi','single','manager','employee','payroll'] as const;
describe('route read budget: repeatability',()=>{
 // Equivalence is only meaningful if one mode renders the same output twice: seven alternating renders of the heaviest
 // route must all equal the first, whatever the mode.
 it('renders Home for a company-by-company administrator identically eight times across modes',async()=>{
  const first=await render('home','multi','all','default');
  const modes:Mode[]=['without','default','pool2','independent','pool3','default','without'];
  for(const mode of modes){
   const again=await render('home','multi','all',mode);
   expect(firstDifference(first.output,again.output),`default vs ${mode}`).toBeNull();
  }
 },240_000);
});

describe.each(BUDGET_ROUTES)('route read budget: %s',route=>{
 it.each(ROLES)('renders identically with and without the default join, for %s, and never costs more transactions',async persona=>{
  // One unmeasured render first: process-level caches (tenant facts the first transaction learns) fill once.
  await render(route,persona,'all','default');
  const shared=await render(route,persona,'all','default');
  const independent=await render(route,persona,'all','without');
  const unshared=await render(route,persona,'all','independent');
  expect(firstDifference(shared.output,independent.output),'default vs explicit snapshots only').toBeNull();
  expect(firstDifference(shared.output,unshared.output),'default vs no shared snapshot').toBeNull();
  // The bounded pool: identical output, at most N carriers per identity at once, never more transactions than off.
  for(const [mode,size] of [['pool2',2],['pool3',3]] as const){
   const pooled=await render(route,persona,'all',mode);
   expect(firstDifference(shared.output,pooled.output),`default vs ${mode}`).toBeNull();
   // The pool, plus the page's one carrier beside a frame that holds the whole pool.
   expect(pooled.peakCarriers,`${mode} carriers at once`).toBeLessThanOrEqual(size+1);
   expect(pooled.transactions,`${mode} transactions`).toBeLessThanOrEqual(independent.transactions);
  }
  // The render produced real output (a nonempty tree), not an error-shaped stub.
  const redirected=typeof shared.output==='object'&&shared.output!==null&&'redirect' in shared.output;
  if(!redirected)expect(JSON.stringify(shared.output).length).toBeGreaterThan(500);
  expect(shared.transactions).toBeLessThanOrEqual(independent.transactions);
  expect(shared.transactions).toBeGreaterThan(0);
  if(route==='frame'){
   expect(shared.transactions,'frame transactions').toBeLessThanOrEqual(FRAME_TRANSACTIONS);
   // Package 1.3: a page load writes nothing and takes no exclusive advisory lock, whatever the role.
   expect(shared.captured.filter(statement=>WRITE.test(statement.sql)).map(statement=>statement.sql.slice(0,160))).toEqual([]);
   expect(shared.refused.write??0).toBe(0);
  }
  const budget=BUDGETS[route][persona];
  if(budget){
   expect(shared.transactions,`${route} ${persona} transactions`).toBeLessThanOrEqual(budget.transactions);
   expect(shared.statements,`${route} ${persona} statements`).toBeLessThanOrEqual(budget.statements);
  }
 },180_000);

 it.each(['group','employee'] as const)('reports the database time of its statements for %s (default join and without)',async persona=>{
  await render(route,persona,'all','default');
  const shared=await statementTime(await render(route,persona,'all','default'));
  const independent=await statementTime(await render(route,persona,'all','without'));
  await statementTime(await render(route,persona,'all','independent'));
  await statementTime(await render(route,persona,'all','pool2'));
  await statementTime(await render(route,persona,'all','pool3'));
  // The same reads are replayed either way: the default join moves no work between statements.
  expect(shared.replayed).toBeGreaterThan(0);
  expect(independent.replayed).toBeGreaterThan(0);
 },180_000);

 it('costs no more for 71 companies than for one company',async()=>{
  await render(route,'group','all','default');
  // A group administrator: "All companies" against one company chosen in the company switcher.
  const all=await render(route,'group','all','default');
  const one=await render(route,'group','one','default');
  expect(all.transactions,'group transactions').toBeLessThanOrEqual(one.transactions);
  expect(all.statements,'group statements').toBeLessThanOrEqual(one.statements);
  // Company-by-company grants on every company against an administrator of the work-holding company only.
  const multi=await render(route,'multi','all','default');
  const single=await render(route,'base','all','default');
  expect(multi.transactions,'multi transactions').toBeLessThanOrEqual(single.transactions);
  expect(multi.statements,'multi statements').toBeLessThanOrEqual(single.statements);
 },180_000);
});

/** Wall time per mode: interleaved rounds (each round renders every mode once, in a rotated order) after one warm-up per
 * mode, so drift and caches touch every mode alike. `ms` is the whole render, statements and server components. */
const WALL_ROUNDS=5;
const WALL_MODES:Mode[]=['without','default','pool2','pool3'];
async function wallTime(route:Route,persona:keyof typeof personas,modes:Mode[]){
 for(const mode of modes)await render(route,persona,'all',mode);
 const samples:Record<string,number[]>={},transactions:Record<string,number>={},peak:Record<string,number>={};
 for(let round=0;round<WALL_ROUNDS;round++){
  for(let index=0;index<modes.length;index++){
   const mode=modes[(index+round)%modes.length];
   const measured=await render(route,persona,'all',mode);
   (samples[mode]??=[]).push(measured.ms);transactions[mode]=measured.transactions;peak[mode]=Math.max(peak[mode]??0,measured.peakCarriers);
  }
 }
 const median=(values:number[])=>{const sorted=[...values].sort((x,y)=>x-y);return sorted[Math.floor(sorted.length/2)];};
 const summary=Object.fromEntries(modes.map(mode=>[mode,{median:median(samples[mode]),min:Math.min(...samples[mode]),max:Math.max(...samples[mode]),
  transactions:transactions[mode],peakCarriers:peak[mode]}]));
 console.log('ROUTE_WALL '+JSON.stringify({route,persona,rounds:WALL_ROUNDS,...summary}));
 for(const mode of modes)expect(samples[mode]).toHaveLength(WALL_ROUNDS);
}
describe.each(BUDGET_ROUTES)('route read budget: wall time by carrier pool, %s',route=>{
 it.each(['group','manager','employee'] as const)('measures %s in every mode',persona=>wallTime(route,persona,WALL_MODES),240_000);
});

/** The audit log and a payroll run, the two staging pages that were slower with one carrier than with the join off.
 * Last in the file: the run opened here (its payslips, and the access log each view of it writes) is not part of the
 * budget fixture above. */
describe('route read budget: wall time for the audit log and a payroll run, group administrator',()=>{
 beforeAll(async()=>{
  // A regular run for the month after the fixture's ten processed months, processed over the work-holding company's
  // employments (the fixture's largest company; those with a salary and statutory record get a payslip).
  const admin=await entitledCtx(b,['hr_admin']);
  // The fixture gives ~55% of employments a salary; a run refuses to process with any in-scope employee lacking one,
  // so the work-holding company's other active employments get one (only this describe sees them).
  await owner.db.execute(sql`insert into compensation (tenant_id,employment_id,basic_salary,valid_from)
   select e.tenant_id,e.id,3200,'2024-01-01' from employment e where e.company_id=${workCompanyId}::uuid and e.terminated_on is null
    and not exists (select 1 from compensation c where c.employment_id=e.id and c.valid_to is null)`);
  // The fixture writes no employer-scoped PCB selection, and processing refuses an employee whose selection is missing
  // or awaits confirmation ("PCB selected category: confirmation_required", localization/my/tax-selection.ts). Each of
  // these employments gets the confirmed ordinary resident selection HR would record, at its person's current tax
  // applicability epoch, the same row an explicit Personnel selection writes.
  await owner.db.execute(sql`insert into employment_tax_selection_my (tenant_id,employment_id,company_id,scheme,transition_state,tax_applicability_epoch,source,provenance,updated_by_user_id)
   select e.tenant_id,e.id,e.company_id,'resident','resolved',coalesce(s.tax_applicability_epoch,0),'explicit',
    ${JSON.stringify({reason:'route_read_budget_fixture',declarationIds:[]})}::jsonb,${b.adminUserId}::uuid
   from employment e left join employee_statutory_my s on s.person_id=e.person_id and s.tenant_id=e.tenant_id
   where e.company_id=${workCompanyId}::uuid and e.terminated_on is null
   on conflict (tenant_id,employment_id,company_id) do nothing`);
  // The page budgets below are a processed run's, so a run that does not process fails here instead of measuring a
  // draft.
  const run=await createBatch(admin,{companyId:workCompanyId,payPeriod:'2026-11'});
  payrollRunId=run.batchId;
  try{await generatePayslips(admin,{batchId:run.batchId});}
  catch(error){
   console.log('ROUTE_WALL_SETUP '+JSON.stringify({payrollRun:'not processed',error:String((error as Error)?.message??error).slice(0,300)}));
   throw error;
  }
  const [row]=await owner.db.select({payslips:sql<number>`count(*)::int`}).from(schema.payslip).where(sql`${schema.payslip.batchId}=${payrollRunId}::uuid`);
  const [processed]=await owner.db.select({status:schema.payrollBatch.status,payPeriod:schema.payrollBatch.payPeriod}).from(schema.payrollBatch).where(sql`${schema.payrollBatch.id}=${payrollRunId}::uuid`);
  console.log('ROUTE_WALL_SETUP '+JSON.stringify({payrollRunPayslips:row.payslips,...processed}));
  expect(processed.status,'the measured run is processed').toBe('processed');
  expect(row.payslips,'the measured run has payslips').toBeGreaterThan(0);
 },240_000);
 it.each(['audit','payrollRun'] as const)('%s renders identically at a pool of 3 and with the join off, and its wall time is measured',async route=>{
  await render(route,'group','all','pool3');
  const off=await render(route,'group','all','without');
  const pooled=await render(route,'group','all','pool3');
  const redirected=typeof off.output==='object'&&off.output!==null&&'redirect' in off.output;
  expect(redirected,`${route} opens for a group administrator`).toBe(false);
  expect(JSON.stringify(off.output).length).toBeGreaterThan(500);
  expect(firstDifference(off.output,pooled.output),'without vs pool3').toBeNull();
  expect(pooled.peakCarriers,'pool3 carriers at once').toBeLessThanOrEqual(4);
  // Unlike the four budgeted routes, these pages have owners that take a barrier and fall back to their own
  // transaction. An owner that falls back may first have opened a pool carrier for itself alone (BEGIN, identity,
  // COMMIT), so the bound is the join off plus the pooled render's fallbacks.
  expect(pooled.transactions,'pool3 transactions').toBeLessThanOrEqual(off.transactions+pooled.fallbacks);
  console.log('ROUTE_WALL_TRANSACTIONS '+JSON.stringify({route,off:off.transactions,pool3:pooled.transactions,pool3Fallbacks:pooled.fallbacks,refused:pooled.refused}));
  await statementTime(off);await statementTime(pooled);
  await wallTime(route,'group',['without','default','pool3']);
 },300_000);
});
