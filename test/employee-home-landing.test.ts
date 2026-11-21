/**
 * `/` routes each audience to its own Today, and the old dashboard's two addresses are retired (owner decisions,
 * 11 and 12 Nov 2026).
 *
 * - An HR administrator gets Admin Today, a manager Manager Today, and everyone else Employee Today: employees, and
 *   payroll and performance partners (never Admin Today), even a partner who also manages a team.
 * - `/?workspace=dashboard` (the old administrator dashboard) and `/?workspace=team` (the old team workbench) redirect
 *   to `/`, keeping only the parameters `/` reads, before any session read. Following the redirect lands every role on
 *   its own Today.
 *
 * The Today pages are markers here; each has its own tests (test/today-admin-page.dom.test.tsx and the Employee Today
 * suites), and the "Your workspace" links have test/today-workspace-links.test.ts.
 */
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({
 session:{tenantId:'fictional-tenant',personId:'fictional-person',userId:'fictional-login',roles:['employee'] as string[],
  grants:[] as {role:string;companyId:string|null}[],
  entitlements:{tenantId:'fictional-tenant',enabledModules:[] as string[],scopedModules:{},settings:{},tenantStatus:'active'}},
 sessionReads:0,
}));
vi.mock('@/lib/scope',()=>({scopedSession:async()=>{state.sessionReads++;return {s:state.session,scopeIds:['fictional-company'],allowedCount:1};}}));
vi.mock('@/lib/authz',()=>({isAdmin:()=>state.session.roles.includes('hr_admin')}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
vi.mock('next/navigation',()=>({
 notFound:()=>{throw Error('not-found');},
 redirect:(path:string)=>{throw Object.assign(Error('redirect:'+path),{path});},
}));
vi.mock('@/components/today/employee/today-page',()=>({EmployeeTodayPage:({employmentId}:{employmentId?:string})=>React.createElement('main',{'data-employee-today':employmentId??''},'Employee Today')}));
vi.mock('@/components/today/admin/today-pages',()=>({
 AdminTodayPage:({all,employmentId}:{all?:boolean;employmentId?:string})=>React.createElement('main',{'data-admin-today':String(all===true),'data-employment':employmentId??''},'Administrator Today'),
 ManagerTodayPage:({scopeIds,employmentId,recommend}:{scopeIds:readonly string[];employmentId?:string;recommend?:string})=>
  React.createElement('main',{'data-manager-today':scopeIds.join(','),'data-employment':employmentId??'','data-recommend':recommend??''},'Manager Today'),
}));
import DashboardPage from '../app/page';
import {assignedApprovalHref} from '../lib/assigned-approval-focus';
import {retiredWorkspaceRedirect} from '../lib/today/workspace';

type Query=Record<string,string|string[]>;
const render=async(query:Query)=>renderToStaticMarkup(await DashboardPage({searchParams:Promise.resolve(query)}));
/** The address the page redirected to, or null when it rendered. */
const redirectOf=async(query:Query)=>{
 try{await DashboardPage({searchParams:Promise.resolve(query)});return null;}
 catch(error){if(error instanceof Error&&error.message.startsWith('redirect:'))return (error as Error&{path:string}).path;throw error;}
};
/** Follow one redirect to `/` and render where it lands. */
const follow=async(query:Query)=>{
 const target=await redirectOf(query);
 expect(target,'a retired address redirects').not.toBeNull();
 const url=new URL(target!,'https://fictional.invalid');
 expect(url.pathname).toBe('/');
 const next:Query={};
 for(const key of new Set(url.searchParams.keys())){const all=url.searchParams.getAll(key);next[key]=all.length>1?all:all[0];}
 return render(next);
};
const as=(...roles:string[])=>{state.session.roles=roles;state.session.grants=roles.map(role=>({role,companyId:null}));};
const LEAVE_REQUEST='11111111-2222-3333-4444-555555555555';

const ROLES=[
 {name:'HR administrator',roles:['hr_admin'],lands:'Administrator Today'},
 {name:'manager',roles:['manager'],lands:'Manager Today'},
 {name:'employee',roles:['employee'],lands:'Employee Today'},
 {name:'payroll partner',roles:['employee','payroll_partner'],lands:'Employee Today'},
 {name:'performance partner',roles:['employee','performance_partner'],lands:'Employee Today'},
 {name:'performance and compensation partner',roles:['employee','performance_comp_partner'],lands:'Employee Today'},
 {name:'payroll partner who also manages a team',roles:['manager','payroll_partner'],lands:'Employee Today'},
] as const;
const TODAYS=['Administrator Today','Manager Today','Employee Today'];

beforeEach(()=>{as('employee');state.session.entitlements.enabledModules=[];state.sessionReads=0;});

describe('`/` draws each audience its own Today',()=>{
 it.each(ROLES)('$name lands on $lands, and on no other Today',async({roles,lands})=>{
  as(...roles);
  const html=await render({});
  expect(html).toContain(lands);
  for(const other of TODAYS.filter(today=>today!==lands))expect(html).not.toContain(other);
 });
 it('passes the own employment choice and "See all" through',async()=>{
  expect(await render({employmentId:'selected-own'})).toContain('data-employee-today="selected-own"');
  as('manager');expect(await render({employmentId:'own-second'})).toContain('data-employment="own-second"');
  as('hr_admin');expect(await render({needs:'all'})).toContain('data-admin-today="true"');
 });
 it('ignores a workspace value that was never an address of the old dashboard',async()=>{
  expect(await redirectOf({workspace:'fictional'})).toBeNull();
  expect(await render({workspace:'fictional'})).toContain('Employee Today');
 });
 it('rejects an ambiguous employment choice before composing Today',async()=>{
  await expect(DashboardPage({searchParams:Promise.resolve({employmentId:['one','two']})})).rejects.toThrow('not-found');
 });
});

describe('the old dashboard addresses redirect to the person\'s own Today',()=>{
 for(const workspace of ['dashboard','team'] as const){
  it.each(ROLES)(`?workspace=${workspace}: $name is redirected to / before any session read, and lands on $lands`,async({roles,lands})=>{
   as(...roles);
   expect(await redirectOf({workspace})).toBe('/');
   expect(state.sessionReads,'redirected before the session was read').toBe(0);
   const html=await follow({workspace});
   expect(html).toContain(lands);
   expect(html).not.toContain('workspace=');
  });
  it(`?workspace=${workspace} keeps only the parameters / reads`,async()=>{
   expect(await redirectOf({workspace,employmentId:'own-second',moduleUnavailable:'claims',why:'leave:x',abs:'1'}))
    .toBe('/?moduleUnavailable=claims&employmentId=own-second');
   expect(await redirectOf({workspace:[workspace]})).toBe('/');
   as('manager');
   expect(await follow({workspace,employmentId:'own-second'})).toContain('data-employment="own-second"');
  });
 }
 it('the redirect target is computed from the retired address alone (pure)',()=>{
  expect(retiredWorkspaceRedirect(undefined)).toBeNull();
  expect(retiredWorkspaceRedirect({})).toBeNull();
  expect(retiredWorkspaceRedirect({workspace:'team',needs:'all',recommend:LEAVE_REQUEST})).toBe(`/?needs=all&recommend=${LEAVE_REQUEST}`);
  expect(retiredWorkspaceRedirect({workspace:['fictional','dashboard']})).toBe('/');
 });
});

describe('the leave recommendation link',()=>{
 const review=assignedApprovalHref({kind:'leave',id:LEAVE_REQUEST});
 it.each([['hr_admin'],['employee','payroll_partner'],['employee','performance_partner']])('%s: opens the request\'s own review on /approvals',async(...roles)=>{
  as(...roles);
  expect(await redirectOf({recommend:LEAVE_REQUEST})).toBe(review);
 });
 it('a manager opens it in place on Manager Today',async()=>{
  as('manager');
  expect(await render({recommend:LEAVE_REQUEST})).toContain(`data-recommend="${LEAVE_REQUEST}"`);
 });
 it('an employee keeps Employee Today, and a malformed request is ignored',async()=>{
  expect(await render({recommend:LEAVE_REQUEST})).toContain('Employee Today');
  as('hr_admin');
  expect(await render({recommend:'not-a-request'})).toContain('Administrator Today');
 });
});
