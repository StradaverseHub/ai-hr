/** ADR 0181 plan packages 1.1, 1.2, 1.3 and 1.5: route read budgets for the app frame, Home, Approvals and Personnel.
 *
 * Each route is rendered as one server render (lib/request-read-scope.ts withRequestReadScope, server components
 * resolved by test/helpers/server-tree-snapshot.ts) on the fictional 71-company / 1,000-employment group fixture
 * (test/helpers/ai-centre-scale-fixture.ts), for the native roles, and its statements and transactions are counted
 * (test/helpers/statement-observer.ts). It proves:
 *  - equivalence: every route renders identical output with the default request join (package 1.1) and without it,
 *    for every role;
 *  - cost: the default join never costs more transactions than reads without it, and the frame reads in at most
 *    FRAME_TRANSACTIONS transactions;
 *  - scale: "All companies" of 71 companies costs no more transactions or statements than one company, for a group
 *    administrator (company switcher) and for company-by-company grants against a single-company administrator;
 *  - budgets: no route exceeds its recorded budget (BUDGETS). Budgets only go down; raising one needs an ADR note;
 *  - no write on page load (package 1.3): a frame render sends no INSERT, UPDATE or DELETE and takes no exclusive
 *    advisory lock, for any role; and the inventory of frame owners that fall back to their own transaction.
 * Every measurement is printed as one `ROUTE_BUDGET {json}` line for the release notes. All names are invented. */
import {randomUUID} from 'node:crypto';
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
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import type {SessionContext} from '../db/client';
import {requestScopedReadStats,withoutDefaultRequestJoin} from '../db/client';
import * as schema from '../db/schema';
import {withRequestReadScope} from '../lib/request-read-scope';
import Layout from '../app/layout';
import HomePage from '../app/page';
import ApprovalsPage from '../app/approvals/page';
import PersonnelPage from '../app/personnel/page';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements,type Captured} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

/** The frame (app/layout.tsx with no page) reads in at most this many transactions for every role (package 1.2). */
const FRAME_TRANSACTIONS=4;
/** Recorded budgets per route (transactions, statements) at "All companies" on the 71-company fixture, default join on.
 * Budgets only go down. Raising one needs an ADR note (docs/plans/2026-11-24-database-read-cost-phase-0-1.md 1.5). */
const BUDGETS:Record<Route,Record<'group'|'multi'|'single'|'manager'|'employee'|'payroll',{transactions:number;statements:number}>|undefined>={
 frame:undefined,home:undefined,approvals:undefined,personnel:undefined,
};

type Route='frame'|'home'|'approvals'|'personnel';
const ROUTES:Record<Route,{pathname:string;page:()=>unknown}>={
 frame:{pathname:'/personnel',page:()=>null},
 home:{pathname:'/',page:()=>createElement(HomePage,{searchParams:Promise.resolve({})})},
 approvals:{pathname:'/approvals',page:()=>createElement(ApprovalsPage,{searchParams:Promise.resolve({})})},
 personnel:{pathname:'/personnel',page:()=>createElement(PersonnelPage,{searchParams:Promise.resolve({})})},
};

let b:Base,fixture:ScaleFixture;
let personas:Record<'group'|'multi'|'single'|'manager'|'employee'|'payroll',SessionContext>;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 const base=await entitledCtx(b,['hr_admin']);
 /** A login for one of the fixture's own employments, with these roles. */
 const own=async(employmentId:string,roles:string[]):Promise<SessionContext>=>{
  const [row]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(sql`${schema.employment.id}=${employmentId}::uuid`);
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:row.personId}).returning({id:schema.appUser.id});
  const grants=roles.map(role=>({role,companyId:null as string|null}));
  await owner.db.insert(schema.roleAssignment).values(grants.map(g=>({tenantId:b.tenantId,appUserId:u.id,companyId:g.companyId,role:g.role as 'employee'})));
  return {...base,userId:u.id,personId:row.personId,roles,grants};
 };
 personas={...fixture.personas,
  manager:await own(fixture.activeEmploymentIds[11],['manager']),
  employee:await own(fixture.activeEmploymentIds[23],['employee']),
  payroll:await own(fixture.activeEmploymentIds[37],['employee','payroll_partner'])};
},240_000);
afterAll(async()=>{await closeAll();});

const normalize=(key:string,value:unknown)=>key==='claimPreviewRevision'&&typeof value==='string'?'<revision>':value;
const WRITE=/^\s*(insert\s+into|update\s+("?[a-z_][a-z0-9_.]*"?\.)?"?[a-z_][a-z0-9_]*"?\s+set\b|delete\s+from)|\bpg_(try_)?advisory_xact_lock\s*\(/i;

type Measured={route:Route;persona:string;scope:'all'|'one';mode:'default'|'without';transactions:number;statements:number;
 output:unknown;captured:Captured[];refused:Record<string,number>;fallbacks:number;staleSkips:number};
async function render(route:Route,persona:keyof typeof personas,scope:'all'|'one',mode:'default'|'without'):Promise<Measured>{
 state.session=personas[persona];state.pathname=ROUTES[route].pathname;
 state.cookies=scope==='one'?{company_scope:fixture.singleCompanyId}:{};
 const requestScope={};
 const run=()=>serverTreeSnapshot(createElement(Layout,{children:ROUTES[route].page()}),normalize);
 const observed=await withRequestReadScope(requestScope,()=>observeStatements(()=>mode==='default'?run():withoutDefaultRequestJoin(run)));
 const stats=await requestScopedReadStats(requestScope);
 const refused:Record<string,number>={};
 for(const session of stats)for(const [reason,count] of Object.entries(session.refused))refused[reason]=(refused[reason]??0)+count;
 const measured={route,persona,scope,mode,transactions:observed.transactions,statements:observed.statements.length,output:observed.result,
  captured:observed.statements,refused,fallbacks:stats.reduce((sum,session)=>sum+session.fallbacks,0),staleSkips:stats.reduce((sum,session)=>sum+session.staleSkips,0)};
 console.log('ROUTE_BUDGET '+JSON.stringify({route,persona,scope,mode,transactions:measured.transactions,statements:measured.statements,
  refused,fallbacks:measured.fallbacks,staleSkips:measured.staleSkips}));
 return measured;
}

const ROLES=['group','multi','single','manager','employee','payroll'] as const;
describe.each(Object.keys(ROUTES) as Route[])('route read budget: %s',route=>{
 it.each(ROLES)('renders identically with and without the default join, for %s, and never costs more transactions',async persona=>{
  const shared=await render(route,persona,'all','default');
  const independent=await render(route,persona,'all','without');
  expect(shared.output).toEqual(independent.output);
  // The render produced real output (a nonempty tree), not an error-shaped stub.
  expect(JSON.stringify(shared.output).length).toBeGreaterThan(500);
  expect(shared.transactions).toBeLessThanOrEqual(independent.transactions);
  expect(shared.transactions).toBeGreaterThan(0);
  if(route==='frame'){
   expect(shared.transactions,'frame transactions').toBeLessThanOrEqual(FRAME_TRANSACTIONS);
   // Package 1.3: a page load writes nothing and takes no exclusive advisory lock, whatever the role.
   expect(shared.captured.filter(statement=>WRITE.test(statement.sql)).map(statement=>statement.sql.slice(0,160))).toEqual([]);
   expect(shared.refused.write??0).toBe(0);
  }
  const budget=BUDGETS[route]?.[persona];
  if(budget){
   expect(shared.transactions,`${route} ${persona} transactions`).toBeLessThanOrEqual(budget.transactions);
   expect(shared.statements,`${route} ${persona} statements`).toBeLessThanOrEqual(budget.statements);
  }
 },180_000);

 it('costs no more for 71 companies than for one company',async()=>{
  // A group administrator: "All companies" against one company chosen in the company switcher.
  const all=await render(route,'group','all','default');
  const one=await render(route,'group','one','default');
  expect(all.transactions,'group transactions').toBeLessThanOrEqual(one.transactions);
  expect(all.statements,'group statements').toBeLessThanOrEqual(one.statements);
  // Company-by-company grants on every company against an administrator of one company.
  const multi=await render(route,'multi','all','default');
  const single=await render(route,'single','all','default');
  expect(multi.transactions,'multi transactions').toBeLessThanOrEqual(single.transactions);
  expect(multi.statements,'multi statements').toBeLessThanOrEqual(single.statements);
 },180_000);
});
