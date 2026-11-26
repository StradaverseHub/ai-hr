/** ADR 0181 Phase 3, decision 3: the cached viewer menu profile (owner decision 25 November 2026, "access version +
 * 60 s"; app/viewer-menu-profile.ts, lib/viewer-menu-cache.ts, migration 7260).
 *
 * On the fictional 71-company / 1,000-employment group fixture, for every native role (group, company-by-company and
 * single-company administrators, a manager, an employee, a payroll partner), under "All companies" and one company:
 *  - identical menus: the frame renders exactly as it does with the cache switched off, on the read that fills the
 *    cache and on the read served from it;
 *  - cost: a draw served from the cache reads none of the menu definer functions (only the access version), and its
 *    statement count and database time are compared with the uncached draw (printed as `VIEWER_MENU {json}`);
 *  - an access change (a role assignment) increments the tenant's access version in the same transaction, and the
 *    next draw reads the menu again and equals the uncached draw: visible immediately, no time limit involved;
 *  - a business-data fact is never served after 60 s: past the limit the menu is read again;
 *  - the live work queues are read on every draw, cached or not.
 * All names are invented. */
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,pathname:'/personnel',cookies:{} as Record<string,string>}));
vi.mock('next/font/google',()=>{const font=()=>({variable:'fixture-font'});return {Plus_Jakarta_Sans:font,Geist_Mono:font,DM_Mono:font};});
vi.mock('next/font/local',()=>({default:()=>({variable:'fixture-local-font'})}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers({'x-pathname':state.pathname}),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next-intl/server',()=>{
 const translator=(namespace?:string)=>{
  const t=(key:string,values?:Record<string,unknown>)=>`${namespace?namespace+'.':''}${key}${values?JSON.stringify(values):''}`;
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

import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {withRequestReadScope} from '../lib/request-read-scope';
import {viewerMenuCache} from '../lib/viewer-menu-cache';
import Layout from '../app/layout';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {explainStatements,observeStatements,type Captured} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

const ROLES=['group','multi','single','manager','employee','payroll'] as const;
type Role=(typeof ROLES)[number];
/** The menu definer functions the cache answers for (staging statement report, 24 November 2026). */
const MENU_OWNERS=/letter_permission_for_user|reward_capability|offboarding_posting_queue_access|probation_navigation_access|probation_access_navigation|contract_shared_navigation_access/i;
/** Live work queues, read on every draw. */
const WORK_QUEUES=/contract_shared_work_page|contract_shared_posting_work_page/i;

let b:Base,fixture:ScaleFixture;
let personas:Record<Role,SessionContext>;
let workCompanyId:string;

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 const base=await entitledCtx(b,['hr_admin']);
 const own=async(employmentId:string,roles:string[],companyId:string|null=null):Promise<SessionContext>=>{
  const [row]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(sql`${schema.employment.id}=${employmentId}::uuid`);
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:row.personId}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values(roles.map(role=>({tenantId:b.tenantId,appUserId:u.id,companyId,role:role as 'employee'})));
  return {...base,userId:u.id,personId:row.personId,roles,grants:roles.map(role=>({role,companyId}))};
 };
 personas={...fixture.personas,
  manager:await own(fixture.activeEmploymentIds[11],['manager']),
  employee:await own(fixture.activeEmploymentIds[23],['employee']),
  payroll:await own(fixture.activeEmploymentIds[37],['employee','payroll_partner'])};
 workCompanyId=b.companyId;
},300_000);
afterEach(()=>{delete process.env.AIHR_VIEWER_MENU_CACHE;vi.restoreAllMocks();viewerMenuCache().clear();});
afterAll(async()=>{await closeAll();});

type Draw={output:unknown;statements:Captured[];transactions:number};
async function draw(role:Role,scope:'all'|'one',cache:'on'|'off'):Promise<Draw>{
 state.session=personas[role];state.pathname='/personnel';
 state.cookies=scope==='one'?{company_scope:role==='single'?fixture.singleCompanyId:workCompanyId}:{};
 if(cache==='off')process.env.AIHR_VIEWER_MENU_CACHE='off';else delete process.env.AIHR_VIEWER_MENU_CACHE;
 const observed=await withRequestReadScope({},()=>observeStatements(()=>serverTreeSnapshot(createElement(Layout,{children:null}),
  (key,value)=>key==='claimPreviewRevision'&&typeof value==='string'?'<revision>':value)));
 return {output:observed.result,statements:observed.statements,transactions:observed.transactions};
}
const menuReads=(d:Draw)=>d.statements.filter(s=>MENU_OWNERS.test(s.sql)).length;
const versionReads=(d:Draw)=>d.statements.filter(s=>/viewer_access_version/.test(s.sql)).length;
async function dbMs(d:Draw){const rows=await explainStatements(d.statements);return Math.round(rows.reduce((sum,row)=>sum+(row.executionMs??0)+(row.planningMs??0),0));}
async function accessVersion(session:SessionContext){return withTenant(session,async tx=>{const [row]=await tx.execute<{v:string}>(sql`select app.viewer_access_version()::text as v`);return BigInt(row.v);});}

describe('viewer menu profile: identical menus and cost',()=>{
 for(const role of ROLES)for(const scope of ['all','one'] as const){
  it(`renders the frame identically uncached, filling and served from the cache (${role}, ${scope})`,async()=>{
   const uncached=await draw(role,scope,'off');
   const filling=await draw(role,scope,'on');
   const served=await draw(role,scope,'on');
   expect(filling.output).toEqual(uncached.output);
   expect(served.output).toEqual(uncached.output);
   expect(menuReads(uncached),'the uncached frame reads its menu owners').toBeGreaterThan(0);
   expect(versionReads(uncached)).toBe(0);
   expect(menuReads(served),'a served frame reads none of the menu owners').toBe(0);
   expect(versionReads(served)).toBe(1);
   expect(served.statements.length).toBeLessThan(uncached.statements.length);
   // The live queues are read whether or not the menu is cached.
   expect(served.statements.filter(s=>WORK_QUEUES.test(s.sql)).length).toBe(uncached.statements.filter(s=>WORK_QUEUES.test(s.sql)).length);
   if(scope==='all'){
    const [before,after]=[await dbMs(uncached),await dbMs(served)];
    console.log('VIEWER_MENU '+JSON.stringify({role,uncached:{statements:uncached.statements.length,transactions:uncached.transactions,dbMs:before,menuReads:menuReads(uncached)},
     served:{statements:served.statements.length,transactions:served.transactions,dbMs:after,menuReads:menuReads(served)}}));
   }
  },240_000);
 }
});

describe('viewer menu profile: invalidation',()=>{
 it('shows an access change on the very next draw: the role assignment increments the access version',async()=>{
  const role:Role='employee';
  await draw(role,'all','on');
  const cached=await draw(role,'all','on');
  expect(menuReads(cached)).toBe(0);
  const before=await accessVersion(personas[role]);
  // An administrator gives this login a manager role for its company (any role assignment maintains 7210).
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:personas[role].userId!,companyId:b.companyId,role:'manager'});
  const after=await accessVersion(personas[role]);
  expect(after).toBeGreaterThan(before);
  const next=await draw(role,'all','on');
  expect(menuReads(next),'the menu is read again at once').toBeGreaterThan(0);
  expect(next.output).toEqual((await draw(role,'all','off')).output);
  // The session that the sign-in service issues next carries the new claim: a different key, read again.
  personas[role]={...personas[role],roles:[...personas[role].roles!,'manager'],grants:[...personas[role].grants!,{role:'manager',companyId:b.companyId}]};
  const reissued=await draw(role,'all','on');
  expect(menuReads(reissued)).toBeGreaterThan(0);
  expect(reissued.output).toEqual((await draw(role,'all','off')).output);
 },240_000);

 it('never serves a menu older than 60 s, so business-data facts appear within the limit',async()=>{
  const role:Role='manager';
  const start=Date.now();
  await draw(role,'all','on');
  const now=vi.spyOn(Date,'now');
  now.mockReturnValue(start+59_000);
  expect(menuReads(await draw(role,'all','on')),'inside the limit: served').toBe(0);
  now.mockReturnValue(start+61_000);
  const expired=await draw(role,'all','on');
  expect(menuReads(expired),'past the limit: read again').toBeGreaterThan(0);
  now.mockRestore();
  expect(expired.output).toEqual((await draw(role,'all','off')).output);
 },240_000);

 it('keys letters by company scope, so a scope switch is never served another scope\'s destinations',async()=>{
  const role:Role='group';
  const all=await draw(role,'all','on');
  const one=await draw(role,'one','on');
  expect(one.output).toEqual((await draw(role,'one','off')).output);
  expect(all.statements.some(s=>/letter_permission_for_user/.test(s.sql))).toBe(true);
  expect(one.statements.some(s=>/letter_permission_for_user/.test(s.sql)),'another scope is another entry').toBe(true);
 },240_000);
});
