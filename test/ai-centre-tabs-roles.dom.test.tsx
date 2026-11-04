/** @vitest-environment jsdom */
/** Issue 17 (owner: "Merge both entirely", 3 November 2026; mock-ups Operations.dc.html and Ask.dc.html): the AI Centre
 * tab row is Ask · Delegated jobs · Operations ▾ · Administration ▾ · How it works (the Inbox tab is retired: Today at /
 * replaces it, AI v2 Phase 1), and the former Control
 * Tower pages render inside it with Operations' second row (Overview, Exceptions, Record readiness, Proposed actions,
 * Opportunities). Rendered with the real tab components and the real Record readiness page, per role, from the
 * same isAdmin predicate requireAdmin uses. Fictional data owners only. In CI the rendered page is also captured at
 * desktop (1440px) and phone (390px) width in Chrome, which fails on any horizontal page overflow. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import type {ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {withAiCentre} from './helpers/ai-centre-messages';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi_ from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';

type Locale='en'|'ms'|'zh'|'vi'|'ta'|'th';
const CATALOGUES={en,ms,zh,vi:vi_,ta,th};
const messagesFor=(locale:Locale)=>withAiCentre(locale,CATALOGUES[locale] as Record<string,unknown>) as typeof en & {aiCentre:Record<string,any>};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'ta'|'th',session:null as unknown,payroll:true,reads:0}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator:translator,createFormatter:formatter}=await import('next-intl');
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const all={en:(await import('../messages/en.json')).default,ms:(await import('../messages/ms.json')).default,zh:(await import('../messages/zh.json')).default,vi:(await import('../messages/vi.json')).default,ta:(await import('../messages/ta.json')).default,th:(await import('../messages/th.json')).default};
 return {getTranslations:async(namespace:any)=>translator({locale:state.locale,messages:merge(state.locale,all[state.locale] as any) as any,namespace,onError:error=>{throw error;}}),
  getFormatter:async()=>formatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'})};
});
vi.mock('next/navigation',()=>({
 redirect:vi.fn((url:string)=>{throw Object.assign(Error('NEXT_REDIRECT'),{url});}),
 permanentRedirect:vi.fn((url:string)=>{throw Object.assign(Error('NEXT_REDIRECT'),{url});}),
 usePathname:()=>'/control-tower/readiness',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),
}));
vi.mock('../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:(_ctx:unknown,code:string)=>code!=='payroll'||state.payroll,isModuleEnabledOrFalse:(_ctx:unknown,code:string)=>code!=='payroll'||state.payroll}));
vi.mock('../core/record-readiness',()=>({PEOPLE_PER_GAP:25,recordReadiness:async()=>{state.reads++;return {employees:3,ready:1,gaps:[
 {id:'no_bank_account',blocks:'payment',count:2,people:[
  {employmentId:'00000000-0000-4000-8000-00000000e001',name:'Aina Fictional',employeeCode:'F-001',company:'Demo Sdn Bhd'},
  {employmentId:'00000000-0000-4000-8000-00000000e002',name:'Ben Fictional',employeeCode:'F-002',company:'Demo Sdn Bhd'}]},
]};}}));
import ReadinessPage from '../app/control-tower/readiness/page';
import {AiCentreTabs} from '../components/ai-centre/centre-tabs';
import {isAdmin} from '../lib/authz-model';

const TENANT='00000000-0000-4000-8000-0000000000a1',COMPANY='00000000-0000-4000-8000-0000000000c1';
const SESSIONS={
 employee:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000001',roles:['employee'],grants:[{role:'employee',companyId:COMPANY}]},
 manager:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000002',roles:['employee','manager'],grants:[{role:'manager',companyId:COMPANY}]},
 hrAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000003',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:COMPANY}]},
 groupAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000004',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
} as const;
type Role=keyof typeof SESSIONS;
const wrap=(locale:Locale,node:ReactNode)=>render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} onError={error=>{throw error;}} timeZone="Asia/Kuala_Lumpur">
 <main className="relative min-w-0"><div className="min-w-0">{node}</div></main></NextIntlClientProvider>);
const linksOf=(nav:HTMLElement)=>within(nav).getAllByRole('link').map(link=>[link.textContent,link.getAttribute('href')]);
afterEach(()=>{cleanup();state.locale='en';state.payroll=true;state.session=null;state.reads=0;});

describe('AI Centre tabs per role',()=>{
 // AI v2 Phase 2 (P2-5): Policies, the Living Handbook, for every role (employees read approved text only), between Operations
 // and Insights as in the approved mock-ups.
 // AI v2 Phase 2 (P2-3): Insights, for every role. Its HR capacity ledger section (P2-4) is admin-only inside the view.
 const ALL=[['Ask','/assistant'],['Delegated jobs','/assistant?view=jobs'],['Operations','/control-tower'],['Policies','/policies'],['Insights','/assistant?view=insights'],['Administration','/control-tower/agents/features'],['How it works','/assistant?view=how']];
 it.each([['employee',false],['manager',false],['hrAdmin',true],['groupAdmin',true]] as const)('%s sees exactly the tabs whose guard admits them',(role,admitted)=>{
  expect(isAdmin(SESSIONS[role] as never)).toBe(admitted);
  wrap('en',<AiCentreTabs active="ask" isAdmin={isAdmin(SESSIONS[role] as never)} />);
  const nav=screen.getByRole('navigation',{name:'AI Centre sections'});
  // No Inbox tab for anyone: what waits on the person is on Today.
  expect(within(nav).queryByRole('link',{name:/Inbox/})).toBeNull();
  expect(nav.querySelector('a[href*="view=inbox"]')).toBeNull();
  expect(linksOf(nav)).toEqual(admitted?ALL:ALL.filter(([label])=>label!=='Operations'&&label!=='Administration'));
  // The two group tabs carry the ▾ mark of the approved mock-up; no other tab does.
  expect(nav.querySelectorAll('[data-centre-group-mark]')).toHaveLength(admitted?2:0);
  expect(within(nav).getByRole('link',{current:'page'})).toHaveAttribute('href','/assistant');
 });
});

describe('an Operations page renders inside AI Centre',()=>{
 it.each(['employee','manager'] as const)('%s requesting Record readiness is refused before any read',async role=>{
  state.session=SESSIONS[role];
  await expect(ReadinessPage()).rejects.toMatchObject({url:'/'});
  expect(state.reads).toBe(0);
 });

 it.each(['hrAdmin','groupAdmin'] as const)('%s: both tab rows, Operations and Record readiness current, then the page',async role=>{
  state.session=SESSIONS[role];
  const view=wrap('en',await ReadinessPage());
  expect(state.reads).toBe(1);
  const top=screen.getByRole('navigation',{name:'AI Centre sections'}),second=screen.getByRole('navigation',{name:'Operations sections'});
  expect(within(top).getByRole('link',{current:'page'})).toHaveAttribute('href','/control-tower');
  expect(within(top).getByRole('link',{current:'page'}).textContent).toBe('Operations');
  expect(linksOf(second)).toEqual([['Overview','/control-tower'],['Loops','/control-tower/loops'],['Exceptions','/control-tower/exceptions'],['Record readiness','/control-tower/readiness'],['Proposed actions','/control-tower/actions'],['Opportunities','/control-tower/opportunities']]);
  expect(within(second).getByRole('link',{current:'page'})).toHaveAttribute('href','/control-tower/readiness');
  // Order: the AI Centre row, its second row, then the page's own heading and content.
  const heading=screen.getByRole('heading',{level:1,name:en.controlTower.readinessScreen.title});
  expect(top.compareDocumentPosition(second)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(second.compareDocumentPosition(heading)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('link',{name:'Aina Fictional'})).toHaveAttribute('href','/admin/personnel/00000000-0000-4000-8000-00000000e001');
  // The way back is the tab row; the old "Back to the Control Tower" link and the name are gone.
  expect(screen.queryByRole('link',{name:en.controlTower.readinessScreen.backToTower})).toBeNull();
  expect(view.container.querySelectorAll('a[href="/control-tower"]')).toHaveLength(2);
  expect(view.container.textContent).not.toMatch(/control tower/i);
  // Phone width: both rows scroll sideways inside themselves (from sm they wrap), with 44px targets.
  for(const nav of [top,second]){
   expect(nav.className).toContain('overflow-x-auto');expect(nav.className).toContain('sm:overflow-x-visible');
   for(const link of within(nav).getAllByRole('link'))expect(link.className).toContain('min-h-11');
  }
  if(role==='hrAdmin')await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','ai-centre-operations-readiness','real tab components and Record readiness page; fictional readiness owner; no authenticated server journey','atelier');
 },120000);

 it('without payroll the payroll queues leave the second row, as their sidebar rows did',async()=>{
  state.session=SESSIONS.hrAdmin;state.payroll=false;
  wrap('en',await ReadinessPage());
  expect(linksOf(screen.getByRole('navigation',{name:'Operations sections'})).map(([,href])=>href)).toEqual(['/control-tower','/control-tower/loops','/control-tower/readiness','/control-tower/opportunities']);
 });

 it.each(['ms','zh','vi','ta','th'] as const)('%s: both rows render translated, with no missing message and no Control Tower',async locale=>{
  state.locale=locale;state.session=SESSIONS.groupAdmin;
  const copy=messagesFor(locale);
  const view=wrap(locale,await ReadinessPage());
  const sectionsName=String(copy.aiCentre.sectionsLabel).replace('{tab}',String(copy.aiCentre.tabs.operations));
  const second=screen.getByRole('navigation',{name:sectionsName});
  expect(within(second).getByRole('link',{current:'page'}).textContent).toBe(copy.aiCentre.sections.readiness);
  expect(screen.getByRole('link',{name:copy.aiCentre.tabs.operations})).toHaveAttribute('aria-current','page');
  for(const word of [/control tower/i,/menara kawalan/i,/控制塔/,/tháp điều khiển/i,/கோபுர/,/หอควบคุม/])expect(view.container.textContent).not.toMatch(word);
 });
});
