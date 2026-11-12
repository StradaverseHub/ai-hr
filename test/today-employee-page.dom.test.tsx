/** Employee Today (components/today/employee/today-page.tsx), rendered from fictional owner fixtures: the work assigned
 * to the person (Waiting for your decision), the Performance block, the requests panel's "See all", and failure
 * isolation. An access refusal is still a not-found page; any other failure to read the person's own context or their
 * modules draws the header and one plain note instead of an error page; a panel that throws while it renders is
 * replaced by its own boundary's note and the rest of the page stays. The streamed page is resolved the way the browser
 * finally shows it (test/helpers/server-tree.ts). */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {withAiCentre} from './helpers/ai-centre-messages';
import {resolveServerTree} from './helpers/server-tree';

const fx=vi.hoisted(()=>{
 class FixtureHomeAccessError extends Error{constructor(readonly code:string){super(code);this.name='HomeAccessError';}}
 return {FixtureHomeAccessError,state:{} as {own:unknown;ownError:unknown;moduleError:unknown;waiting:{items:unknown[];total:number};waitingCalls:number;throwPanel:string|null;notices:unknown}};
});
const S=fx.state;

vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const base=(await import('../messages/en.json')).default;
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const messages=merge('en',base);
 return {getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages,namespace:namespace as never}),getLocale:async()=>'en'};
});
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('not-found');},useRouter:()=>({push:vi.fn()}),usePathname:()=>'/'}));
vi.mock('@/db/client',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),withBackgroundReadWork:async(_tenant:string,run:()=>unknown)=>run(),withSharedReadSnapshot:async(_s:unknown,work:()=>unknown)=>work()}));
vi.mock('@/core/employee-home',()=>({HomeAccessError:fx.FixtureHomeAccessError}));
vi.mock('@/components/today/today-page',()=>({GreetingWithName:async()=>'Good morning, Aisyah'}));
vi.mock('@/components/performance-home/performance-home',()=>({PerformanceHomeSlot:async()=><section data-performance-home>Performance</section>}));
vi.mock('@/components/today/employee/reads',()=>({
 moduleState:()=>{if(S.moduleError)throw S.moduleError;return 'on';},
 readOwnContext:async()=>{if(S.ownError)throw S.ownError;return S.own;},
 readAskAllowed:async()=>false,
 readOwnReadiness:async()=>({failed:false,period:{payPeriod:'2026-11',start:'2026-11-01',cutOff:'2026-11-24',source:'company'},items:[]}),
 readOwnPassportCards:async()=>[],readOwnPayHints:async()=>({nextPayment:null,payslips:[]}),
 readOwnTimeOff:async()=>({balances:[],canApply:true}),readOwnCalendar:async()=>({days:[]}),readOwnWeek:async()=>[],
 readOwnRequests:async()=>({requests:[],failed:false}),readManagersAway:async()=>[],
 readWaitingForYou:async()=>{S.waitingCalls++;return S.waiting;},
 readOwnNotices:async()=>S.notices,
}));
vi.mock('@/components/today/employee/panels',async()=>{
 const actual=await vi.importActual<Record<string,unknown>>('../components/today/employee/panels');
 const out:Record<string,unknown>={};
 for(const name of Object.keys(actual))Object.defineProperty(out,name,{enumerable:true,get:()=>S.throwPanel===name?()=>{throw Error(`Fixture ${name} render failure`);}:actual[name]});
 return out;
});

import {EmployeeTodayPage} from '../components/today/employee/today-page';

const messages=withAiCentre('en',en);
const NOW=new Date('2026-11-12T01:30:00Z');
const SESSION={tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles:['employee'],
 entitlements:{tenantId:'fictional-tenant',enabledModules:[],scopedModules:{},settings:{},tenantStatus:'active'}} as never;
const text=(el:Element|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const UNAVAILABLE="We couldn't load your page just now. Please try again in a moment.";

beforeEach(()=>{
 Object.assign(S,{own:{identity:{selectedEmploymentId:'emp-own',role:'employee',employmentState:'selected',employments:[]},companyId:'co-a'},
  ownError:null,moduleError:null,waiting:{items:[],total:0},waitingCalls:0,throwPanel:null,
  notices:{version:1,employmentId:'emp-own',total:0,unread:0,acknowledgementRequired:0,items:[]}});
});
afterEach(cleanup);

async function show(){
 const tree=await resolveServerTree(await EmployeeTodayPage({session:SESSION,scopeIds:['co-a'],now:NOW}));
 const view=render(<NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">{tree}</NextIntlClientProvider>);
 return {...view,panel:(id:string)=>view.container.querySelector(`[data-today-panel="${id}"]`)};
}

describe('Employee Today: work assigned to the person',()=>{
 it('draws no "Waiting for your decision" panel when nothing waits, and mounts the Performance block',async()=>{
  const view=await show();
  expect(S.waitingCalls).toBeGreaterThan(0);
  expect(view.panel('today-waiting')).toBeNull();
  expect(view.container.querySelector('[data-today-performance] [data-performance-home]')).not.toBeNull();
  expect(view.panel('today-next-step')??view.container.querySelector('[data-today-all-clear]')).not.toBeNull();
 });
 it('lists what waits and links "See all" to the Tasks page, which lists exactly the count it shows',async()=>{
  S.waiting={total:4,items:[
   {id:'p1',kind:'profile',subjectName:'Fictional Peer',createdAt:'2026-11-10T02:00:00Z',linkPath:'/admin/personnel/profile-changes?assigned=1&requestId=p1#request-p1'},
   {id:'r1',kind:'performanceReview',subjectName:null,createdAt:'2026-11-09T02:00:00Z',linkPath:'/performance/workspace?cycle=c1&view=team'},
   {id:'w1',kind:'rewardReview',subjectName:null,createdAt:'2026-11-08T02:00:00Z',linkPath:'/rewards/review'},
   {id:'l1',kind:'leave',subjectName:'Fictional Report',createdAt:'2026-11-07T02:00:00Z',linkPath:'/approvals?category=leave&requestId=l1'}]};
  const view=await show();
  const waiting=view.panel('today-waiting')!;
  expect(waiting.querySelector('[data-today-waiting]')?.getAttribute('data-today-waiting')).toBe('4');
  expect(text(waiting.querySelector('[data-today-waiting]'))).toBe('4 items are waiting for you');
  expect(within(waiting as HTMLElement).getByRole('link',{name:'See all 4'}).getAttribute('href')).toBe('/tasks');
  expect([...waiting.querySelectorAll('[data-today-waiting-item] a')].map(link=>[text(link),link.getAttribute('href')])).toEqual([
   ['Verify profile change · Fictional Peer','/admin/personnel/profile-changes?assigned=1&requestId=p1#request-p1'],
   ['Complete performance review','/performance/workspace?cycle=c1&view=team'],['Review rewards','/rewards/review']]);
 });
 it('offers "See all" for each kind of request the person can make',async()=>{
  const view=await show();
  expect([...view.panel('today-requests')!.querySelectorAll('[data-today-requests-all] a')].map(link=>[text(link),link.getAttribute('href')]))
   .toEqual([['Leave','/leave'],['Claims','/claims'],['Letters','/me/letters']]);
 });
});

describe('Employee Today: the Notice Board and the team cards ported from the retired dashboard',()=>{
 it('lists the newest notices, marks unread ones in words, and links each and the full board',async()=>{
  S.notices={version:1,employmentId:'emp-own',total:2,unread:1,acknowledgementRequired:0,items:[
   {id:'n1',title:'Fictional office closure',summary:'',category:null,pinned:true,requiresAcknowledgement:false,publishedAt:null,publishedBy:null,firstViewedAt:null,acknowledgedAt:null},
   {id:'n2',title:'Fictional town hall',summary:'',category:null,pinned:false,requiresAcknowledgement:false,publishedAt:null,publishedBy:null,firstViewedAt:'2026-11-10T02:00:00Z',acknowledgedAt:null}]};
  const view=await show();
  const board=view.panel('today-notices')!;
  expect(board).not.toBeNull();
  expect([...board.querySelectorAll('[data-today-notice] a')].map(link=>[text(link),link.getAttribute('href')])).toEqual([
   ['Fictional office closure','/notices/n1'],['Fictional town hall','/notices/n2']]);
  expect(board.querySelector('[data-today-notices-unread]')?.getAttribute('data-today-notices-unread')).toBe('1');
  expect(text(board.querySelector('[data-today-notice="n1"]'))).toContain('New');
  expect(text(board.querySelector('[data-today-notice="n2"]'))).not.toContain('New');
  expect(within(board as HTMLElement).getByRole('link',{name:'View all notices'}).getAttribute('href')).toBe('/notices');
 });
 it('says so when there is no notice',async()=>{
  const view=await show();
  expect(text(view.panel('today-notices'))).toContain('No notices right now.');
 });
 it('never shows an employee the team attendance counts or the team links',async()=>{
  const view=await show();
  expect(view.panel('today-team-today')).toBeNull();
  expect(view.container.querySelector('[data-today-team-attendance]')).toBeNull();
  expect(view.container.querySelector('[data-today-workspace]')).toBeNull();
 });
});

describe('Employee Today: failure isolation',()=>{
 it('keeps the not-found page for an employment the person may not open',async()=>{
  S.ownError=new fx.FixtureHomeAccessError('employmentUnavailable');
  await expect(EmployeeTodayPage({session:SESSION,scopeIds:['co-a'],now:NOW})).rejects.toThrow('not-found');
 });
 it('draws the header and one plain note when the person\'s own context cannot be read',async()=>{
  S.ownError=new Error('Fixture identity outage');
  const view=await show();
  expect(text(view.container.querySelector('h1'))).toBe('Good morning, Aisyah');
  expect(view.container.querySelector('[data-today-page-unavailable="context"]')).not.toBeNull();
  expect(text(view.container)).toContain(UNAVAILABLE);
  expect(view.container.querySelectorAll('[data-today-panel]')).toHaveLength(0);
 });
 it('draws the header and one plain note when the modules cannot be read',async()=>{
  S.moduleError=new Error('Fixture wiring failure');
  const view=await show();
  expect(text(view.container.querySelector('h1'))).toBe('Good morning, Aisyah');
  expect(view.container.querySelector('[data-today-page-unavailable="modules"]')).not.toBeNull();
  expect(text(view.container)).toContain(UNAVAILABLE);
 });
 it('keeps a panel that throws while it renders inside its own boundary',async()=>{
  S.throwPanel='RequestsPanel';
  const spy=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
   const view=await show();
   expect(view.panel('today-requests')).toBeNull();
   expect(text(view.container)).toContain('This could not be loaded just now. Its own page still works.');
   expect(view.panel('today-coming-up')).not.toBeNull();
   expect(view.panel('today-calendar')).not.toBeNull();
  }finally{spy.mockRestore();}
 });
});
