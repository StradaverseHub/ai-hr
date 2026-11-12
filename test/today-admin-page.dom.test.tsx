/** HR administrator and manager Today (owner decision, 11 Nov 2026; AdminToday.dc.html, ManagerToday.dc.html), rendered
 * from fictional owner fixtures.
 *
 * The readers the two pages call are replaced by fixtures at their module boundary (components/today/admin/reads.ts,
 * the Employee Today readers for the viewer's own record, and the approvals page's recommendation read). Needs you's
 * fixture is ranked by the real pure rules (lib/today/admin.ts), so the order and the counts asserted here are the
 * page's own; expected text is written out literally from the fixture through the real English catalogue. The streamed
 * page is resolved the way the browser finally shows it (test/helpers/server-tree.ts). */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {withAiCentre} from './helpers/ai-centre-messages';
import {resolveServerTree} from './helpers/server-tree';

const fx=vi.hoisted(()=>({state:{} as {
 needs:unknown;needsPartial:boolean;needsFail:boolean;readiness:unknown;exceptions:{total:number;blocking:number};handled:unknown;handledFail:boolean;
 queue:unknown;summary:{items:unknown[];approvalCount:number};ask:boolean;own:unknown;ownReadiness:unknown;payHints:unknown;push:ReturnType<typeof vi.fn>;recommendCalls:string[][];views:Map<string,unknown>;
 throwPanel:string|null;ownCalls:unknown[];
}}));
const S=fx.state;

vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const base=(await import('../messages/en.json')).default;
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const messages=merge('en',base);
 return {getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages,namespace:namespace as never}),getLocale:async()=>'en'};
});
vi.mock('next/navigation',()=>({useRouter:()=>({push:S.push}),usePathname:()=>'/'}));
vi.mock('@/components/today/today-page',()=>({GreetingWithName:async()=>'Good morning, Zen'}));
vi.mock('@/db/client',async importOriginal=>({...await importOriginal<Record<string,unknown>>(),withBackgroundReadWork:async(_tenant:string,run:()=>unknown)=>run(),withSharedReadSnapshot:async(_s:unknown,work:()=>unknown)=>work()}));
// The Performance block has its own tests (test/p1-wpa2-performance-home.dom.test.tsx); here a marker proves the page mounts it.
vi.mock('@/components/performance-home/performance-home',()=>({PerformanceHomeSlot:async()=><section data-performance-home>Performance</section>}));
// A panel that throws while it renders is replaced by its own boundary's note; the rest of the page stays.
vi.mock('@/components/today/admin/panels',async()=>{
 const actual=await vi.importActual<Record<string,unknown>>('../components/today/admin/panels');
 const out:Record<string,unknown>={};
 for(const name of Object.keys(actual))Object.defineProperty(out,name,{enumerable:true,get:()=>S.throwPanel===name?()=>{throw Error(`Fixture ${name} render failure`);}:actual[name]});
 return out;
});
vi.mock('@/components/today/admin/reads',async()=>{
 const {managerQueue,rankedNeeds}=await import('../lib/today/admin');
 return {
  scopeKey:(ids:readonly string[])=>ids.join(','),
  readAdminNeeds:async()=>{if(S.needsFail)throw Error('Fixture needs outage');return {ranked:rankedNeeds(S.needs as never),failed:S.needsPartial};},
  readReadiness:async()=>S.readiness,
  readExceptions:async()=>S.exceptions,
  readHandled:async()=>{if(S.handledFail)throw Error('Fixture ledger outage');return S.handled;},
  readNeeds:async()=>S.queue,
  readManagerQueue:async()=>({...managerQueue(S.summary as never),failed:false}),
 };
});
vi.mock('@/components/today/employee/reads',()=>({
 moduleState:()=>'on',readAskAllowed:async()=>S.ask,
 readOwnContext:async(_s:unknown,employmentId?:string)=>{S.ownCalls.push(employmentId);return S.own;},readOwnReadiness:async()=>S.ownReadiness,readOwnPassportCards:async()=>[],readOwnPayHints:async()=>S.payHints,
 readManagersAway:async()=>[],readOwnCalendar:async()=>({days:[]}),readOwnRequests:async()=>({requests:[],failed:false}),readOwnTimeOff:async()=>({balances:[],canApply:false}),
 readOwnWeek:async()=>[],
}));
// The approvals page's own recommendation read (its own tests: test/approvals-leave-recommendation.dom.test.tsx).
vi.mock('@/app/approvals/leave-recommendations',()=>({readApprovalRecommendations:async(_s:unknown,ids:readonly string[])=>{
 S.recommendCalls.push([...ids]);return {active:true,views:S.views,deferred:new Set<string>()};}}));

import {AdminTodayPage,ManagerTodayPage} from '../components/today/admin/today-pages';
import {ASK_HANDOFF_KEY} from '../lib/today/ask-handoff';

const messages=withAiCentre('en',en);
// 09:30 on Thursday 12 November 2026 in Malaysia.
const NOW=new Date('2026-11-12T01:30:00Z');
const ADMIN={tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}],
 entitlements:{tenantId:'fictional-tenant',enabledModules:[],scopedModules:{},settings:{},tenantStatus:'active'}} as never;
const MANAGER={...(ADMIN as object),roles:['manager'],grants:[]} as never;
const text=(el:Element|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const task=(id:string,kind:string,createdAt:string,subjectName:string|null=null)=>({id,kind,subjectName,createdAt,linkPath:`/approvals?category=${kind}&requestId=${id}`});

beforeEach(()=>{
 Object.assign(S,{
  needs:{today:'2026-11-12',nextCutOff:'2026-11-25',
   statutory:{overdue:1,dueSoon:0,earliestDue:'2026-11-10'},exceptions:{blocking:38},
   tasks:[task('a1','attendance','2026-10-15T02:00:00Z'),task('a2','attendance','2026-10-20T02:00:00Z'),task('a3','attendance','2026-11-01T02:00:00Z'),task('a4','attendance','2026-11-02T02:00:00Z'),
    task('p1','profile','2026-11-10T02:00:00Z'),task('l1','leave','2026-11-11T02:00:00Z'),task('l2','leave','2026-11-11T03:00:00Z')],
   claimTotal:0,prepared:[],findings:[{key:'readiness',count:12,href:'/control-tower/readiness'}],
   loops:[{kind:'probation',endDate:'2026-11-17',overdue:false,href:'/admin/personnel/e1'},{kind:'probation',endDate:'2026-11-19',overdue:false,href:'/admin/personnel/e2'}]},
  needsPartial:false,needsFail:false,
  readiness:{companies:71,ready:12,waiting:33,notStarted:26,nextCutOff:'2026-11-25',nextPeriod:'2026-11',checking:true,rows:[]},
  exceptions:{total:135,blocking:38},
  handled:{summary:{answeredForYou:2,answeredForOthers:22,leaveChecks:3,preparedForYou:0},loops:[{workerId:'loop_missing_employee_data',opened:186,done:41}]},handledFail:false,
  queue:{tasks:[],taskTotal:0,claimTotal:0,recommender:false,prepared:[],findings:[],loops:[],taskLoops:{},failed:false},
  ask:true,
  own:{identity:{selectedEmploymentId:'emp-own',role:'employee',employmentState:'selected',employments:[]},companyId:'co-a'},
  ownReadiness:{failed:false,period:{payPeriod:'2026-11',start:'2026-11-01',cutOff:'2026-11-24',source:'company'},
   items:[{key:'bank_missing:emp-own',group:'details',kind:'bank_missing',state:'todo',date:null,due:'2026-11-24',action:{href:'/me?tab=bankStatutory'}},
    {key:'tax_number_missing:emp-own',group:'details',kind:'tax_number_missing',state:'todo',date:null,due:'2026-11-24',action:{href:'/me?tab=bankStatutory'}}]},
  payHints:{nextPayment:{date:'2026-11-27'},payslips:[]},
  push:vi.fn(),recommendCalls:[],views:new Map(),throwPanel:null,ownCalls:[],summary:{items:[],approvalCount:0},
 });
 window.sessionStorage.clear();
});
afterEach(cleanup);

async function show(page:'admin'|'manager',all=false,extra:{employmentId?:string;recommend?:string}={}){
 const props={session:page==='admin'?ADMIN:MANAGER,scopeIds:['co-a','co-b'],allCompanies:true,now:NOW,all,...extra};
 const tree=await resolveServerTree(page==='admin'?await AdminTodayPage(props):await ManagerTodayPage(props));
 const view=render(<NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">{tree}</NextIntlClientProvider>);
 const panel=(id:string)=>view.container.querySelector(`[data-today-panel="${id}"]`);
 return {...view,panel};
}

describe('Administrator Today',()=>{
 it('ranks Needs you most urgent first, and its heading and "See all" both count the one list',async()=>{
  const view=await show('admin');
  expect(view.container.querySelector('[data-today="administrator"]')).not.toBeNull();
  expect(text(view.container.querySelector('[data-today-date]'))).toBe('Thursday, November 12, 2026 · All companies');
  // Seven entries: the CP22 overdue, the blocking exceptions, the probation reviews due in five days, then by consequence.
  const heading=view.container.querySelector('[data-today-needs-count]')!;
  expect(heading.getAttribute('data-today-needs-count')).toBe('7');
  expect(text(heading)).toBe('7 things need you · 1 overdue · payroll closes in 13 days');
  const needs=view.panel('today-needs')!;
  expect([...needs.querySelectorAll('[data-today-need]')].map(row=>row.getAttribute('data-today-need')))
   .toEqual(['statutory','exceptions','loop:probation','task:attendance','task:profile']);
  expect([...needs.querySelectorAll('[data-today-need]')].map(row=>row.getAttribute('data-today-tag'))).toEqual(['overdue','blocksPayroll','dueIn','waiting','none']);
  const seeAll=within(needs as HTMLElement).getByRole('link',{name:'See all 7'});
  expect(seeAll.getAttribute('href')).toBe('/?needs=all');
  const rows=[...needs.querySelectorAll('[data-today-need]')].map(text);
  expect(rows[0]).toContain('Overdue 2 days');expect(rows[0]).toContain('File 1 CP22 or CP22A notification');
  expect(rows[1]).toContain('Blocks payroll');expect(rows[1]).toContain('38 payroll exceptions block a run');
  expect(rows[2]).toContain('Due in 5 days');expect(rows[2]).toContain('2 probation periods are ending');
  expect(rows[3]).toContain('Waiting 28 days');expect(rows[3]).toContain('Review attendance correction: 4 waiting');
  // Each row opens the owner's page; nothing on Today decides.
  expect(needs.querySelector('[data-today-need="task:attendance"] a')?.getAttribute('href')).toBe('/approvals?category=all');
  expect(needs.querySelector('[data-today-need="statutory"] a')?.getAttribute('href')).toBe('/payroll/statutory-forms');
  expect(within(view.container).queryByRole('button',{name:/^(approve|decline)/i})).toBeNull();
 });

 it('shows every entry on "See all", with the same count, and the way back',async()=>{
  const view=await show('admin',true);
  const needs=view.panel('today-needs')!;
  expect(needs.querySelectorAll('[data-today-need]')).toHaveLength(7);
  expect(view.container.querySelector('[data-today-needs-count]')?.getAttribute('data-today-needs-count')).toBe('7');
  expect(within(needs as HTMLElement).getByRole('link',{name:'Show the most urgent'}).getAttribute('href')).toBe('/');
 });

 it('draws payroll readiness toward the next cut-off, and says so plainly when the pre-salary check is off',async()=>{
  let view=await show('admin');
  const readiness=view.panel('today-readiness')!;
  expect(readiness.querySelector('[data-today-cut-off]')?.getAttribute('data-today-cut-off')).toBe('2026-11-25');
  expect(readiness.querySelector('[data-today-readiness-bar]')?.getAttribute('aria-label')).toBe('12 of 71 companies ready');
  expect(text(readiness.querySelector('[data-today-readiness="ready"]'))).toBe('12 companies ready');
  expect(text(readiness.querySelector('[data-today-readiness="waiting"]'))).toBe('33 companies waiting on inputs');
  expect(text(readiness.querySelector('[data-today-readiness="notStarted"]'))).toBe('26 companies not checked yet');
  cleanup();
  S.readiness={...(S.readiness as object),checking:false,ready:0,waiting:0,notStarted:71};
  view=await show('admin');
  expect(view.panel('today-readiness')!.querySelector('[data-today-readiness-bar]')).toBeNull();
  expect(text(view.panel('today-readiness')!.querySelector('[data-today-readiness="off"]'))).toBe('71 companies use payroll. The pre-salary check in AI Centre is switched off, so readiness has not been checked.');
 });

 it('says what AI Centre handled from its own records only, and a ledger outage stays inside its own panel',async()=>{
  let view=await show('admin');
  const handled=view.panel('today-handled')!;
  expect([...handled.querySelectorAll('[data-today-handled]')].map(card=>[card.getAttribute('data-today-handled'),[...card.querySelectorAll('p')].map(text).join(' ')])).toEqual([
   ['answered','24 questions answered'],['leaveChecks','3 leave recommendations prepared'],['loop:loop_missing_employee_data','186 Missing employee data: cases found 41 resolved'],
  ]);
  expect(handled.textContent).not.toMatch(/time freed|hours? saved/i);
  cleanup();
  S.handledFail=true;
  view=await show('admin');
  expect(text(view.panel('today-handled')!.querySelector('[data-today-unavailable]'))).toBe('Some figures could not be loaded just now.');
  // The other panels still drew their facts.
  expect(view.panel('today-needs')!.querySelectorAll('[data-today-need]')).toHaveLength(5);
  expect(view.panel('today-readiness')!.querySelector('[data-today-readiness-bar]')).not.toBeNull();
 });

 it('keeps a failed Needs you read to its own panel and drops the heading count rather than guess it',async()=>{
  S.needsFail=true;
  const view=await show('admin');
  expect(view.container.querySelector('[data-today-needs-count]')).toBeNull();
  expect(text(view.panel('today-needs')!.querySelector('[data-today-unavailable]'))).toBe('This could not be loaded just now. Its own page still works.');
  expect(view.panel('today-handled')).not.toBeNull();
 });

 it('draws no dashboard under Today, and every panel stands in its own boundary',async()=>{
  const view=await show('admin');
  expect(view.container.querySelector('[data-today-more]')).toBeNull();
  expect([...view.container.querySelectorAll('[data-today-panel]')].map(panel=>panel.getAttribute('data-today-panel')))
   .toEqual(['today-readiness','today-needs','today-handled','today-watching','today-own','today-ask-prompts']);
  expect(text(view.panel('today-watching')!.querySelector('[data-today-watch="exceptions"]'))).toContain('97 payroll exceptions need a look but do not block a run.');
 });

 it('shows the administrator their own record: what to send to HR, and the next payday',async()=>{
  let view=await show('admin');
  const own=view.panel('today-own')!;
  expect(text(own.querySelector('h2'))).toBe('Your own record');
  expect(own.querySelector('[data-today-own]')?.getAttribute('data-today-own')).toBe('2');
  expect([...own.querySelectorAll('[data-today-step] a')].map(text)).toEqual(['Send your bank account details to HR','Send your income tax number to HR']);
  expect(own.querySelector('[data-today-own-next]')?.getAttribute('data-today-own-next')).toBe('payday');
  cleanup();
  S.own={identity:{selectedEmploymentId:null,role:'employee',employmentState:'none',employments:[]},companyId:null};
  view=await show('admin');
  expect(view.panel('today-own')).toBeNull();
 });

 it('offers the administrator prompts as questions handed to AI Centre Ask, only to someone it can answer',async()=>{
  let view=await show('admin');
  const prompts=view.panel('today-ask-prompts')!;
  const chips=[...prompts.querySelectorAll('[data-today-ask-chip]')];
  expect(chips.map(text)).toEqual(['What is blocking this month\'s payroll?','Who has not sent their claims before the cut-off?','Which approvals have waited more than 3 days?']);
  fireEvent.click(chips[0]);
  expect(JSON.parse(window.sessionStorage.getItem(ASK_HANDOFF_KEY)!).q).toBe('What is blocking this month\'s payroll?');
  expect(S.push).toHaveBeenCalledWith('/assistant');
  cleanup();
  S.ask=false;
  view=await show('admin');
  expect(view.panel('today-ask-prompts')).toBeNull();
  expect(view.container.querySelector('[data-today-ask]')).toBeNull();
 });
});

describe('Administrator Today, every panel on its own',()=>{
 it('mounts the Performance block, and keeps a panel that throws while it renders inside its own boundary',async()=>{
  let view=await show('admin');
  expect(view.container.querySelector('[data-today-performance] [data-performance-home]')).not.toBeNull();
  cleanup();
  S.throwPanel='ReadinessPanel';
  const spy=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
   view=await show('admin');
   expect(view.panel('today-readiness')).toBeNull();
   expect(view.panel('today-needs')!.querySelectorAll('[data-today-need]')).toHaveLength(5);
   expect(view.panel('today-handled')).not.toBeNull();
   expect(text(view.container)).toContain('This could not be loaded just now. Its own page still works.');
  }finally{spy.mockRestore();}
 });
 it('lets someone with several own employments choose one for their own record, and reads the one chosen',async()=>{
  S.own={identity:{selectedEmploymentId:null,role:'employee',employmentState:'choose',employments:[{employmentId:'emp-a',company:'Fictional A Sdn Bhd',employeeCode:'A1'},
   {employmentId:'emp-b',company:'Fictional B Sdn Bhd',employeeCode:'B1'}]},companyId:null};
  let view=await show('admin');
  expect([...view.panel('today-own')!.querySelectorAll('[data-today-own-choose] a')].map(link=>link.getAttribute('href'))).toEqual(['/?employmentId=emp-a','/?employmentId=emp-b']);
  cleanup();
  S.own={identity:{selectedEmploymentId:'emp-b',role:'employee',employmentState:'selected',employments:[]},companyId:'co-b'};
  view=await show('admin',false,{employmentId:'emp-b'});
  expect(S.ownCalls).toContain('emp-b');
  expect(view.panel('today-own')!.querySelector('[data-today-own]')).not.toBeNull();
 });
});

describe('Manager Today',()=>{
 const other=(id:string,kind:string,createdAt:string,linkPath:string,subjectName:string|null=null)=>({id,kind,subjectName,createdAt,linkPath});
 beforeEach(()=>{
  // The queue as the approvals owner summarises it: five decisions /approvals lists plus two claims it did not list
  // (approvalCount 8 with l9), a profile change and a performance review each decided on their own page, and a notice
  // acknowledgement that is the manager's own and never a team decision.
  S.summary={approvalCount:8,items:[task('c1','claim','2026-11-11T02:00:00Z','Arjun Fictional'),task('l2','leave','2026-11-10T02:00:00Z','Mei Fictional'),
   task('a1','attendance','2026-11-05T02:00:00Z','Wei Fictional'),task('l1','leave','2026-11-09T02:00:00Z','Aisyah Fictional'),task('l3','leave','2026-11-12T01:00:00Z','Siti Fictional'),
   task('l9','leave','2026-11-12T05:00:00Z','Nur Fictional'),
   other('p1','profile','2026-11-11T05:00:00Z','/admin/personnel/profile-changes?assigned=1&requestId=p1#request-p1','Ravi Fictional'),
   other('pr1','performanceReview','2026-11-08T05:00:00Z','/performance/workspace?cycle=c1&view=team','Kumar Fictional'),
   other('n1','noticeAcknowledgement','2026-11-01T02:00:00Z','/notices/n1?employmentId=e1','Fictional notice')]};
  S.queue={tasks:[],taskTotal:0,claimTotal:0,recommender:true,prepared:[],findings:[],taskLoops:{},failed:false,
   loops:[{kind:'probation',caseId:'case-1',name:'Daniel Fictional',endDate:'2026-11-20',stage:'with_manager',overdue:false,reviewId:null,href:'/admin/personnel/e9'}]};
  S.views=new Map<string,unknown>([['l1',{kind:'recommendation',verdict:'recommend_approve',failedRules:[]}],
   ['l2',{kind:'recommendation',verdict:'needs_review',failedRules:[{check:'team_coverage',blocking:false,version:null}]}]]);
 });
 const row=(decide:Element,id:string)=>[...decide.querySelectorAll('[data-today-task]')].find(li=>li.querySelector('a')?.getAttribute('href')?.includes(`requestId=${id}`));

 it('counts only the decisions /approvals lists, in the heading and in "See all", oldest first',async()=>{
  const view=await show('manager');
  expect(view.container.querySelector('[data-today="manager"]')).not.toBeNull();
  expect(text(view.container.querySelector('[data-today-date]'))).toBe('Thursday, November 12, 2026');
  expect(text(view.container.querySelector('[data-today-decision-count]'))).toBe('8 decisions for your team');
  const decide=view.panel('today-decide')!;
  expect([...decide.querySelectorAll('[data-today-decisions] [data-today-task] > div > p:first-child')].map(text)).toEqual([
   'Review attendance correction · Wei Fictional','Approve leave request · Aisyah Fictional','Approve leave request · Mei Fictional',
   'Approve expense claim · Arjun Fictional','Approve leave request · Siti Fictional']);
  const seeAll=within(decide as HTMLElement).getByRole('link',{name:'See all 8'});
  expect(seeAll.getAttribute('href')).toBe('/approvals');
  expect(view.container.querySelector('[data-today-more]')).toBeNull();
 });

 it('shows other assigned work as its own rows with its own links, and never a notice acknowledgement',async()=>{
  const view=await show('manager');
  const otherRows=view.panel('today-decide')!.querySelector('[data-today-other-work]')!;
  expect([...otherRows.querySelectorAll('[data-today-task]')].map(li=>[li.getAttribute('data-today-task'),li.querySelector('a')?.getAttribute('href')])).toEqual([
   // Each opens its owner's page, marked as opened from Today (lib/ai-centre/inbox-origin.ts).
   ['performanceReview','/performance/workspace?cycle=c1&view=team&from=today'],['profile','/admin/personnel/profile-changes?assigned=1&requestId=p1&from=today#request-p1']]);
  expect(view.container.querySelector('[data-today-task="noticeAcknowledgement"]')).toBeNull();
  expect(text(view.panel('today-decide'))).toContain('2 other items are waiting for you');
 });

 it('shows the leave recommendation inline on each leave decision only, and its note only when one came back',async()=>{
  let view=await show('manager');
  expect(new Set(S.recommendCalls.map(ids=>ids.join(',')))).toEqual(new Set(['l1,l2,l3']));
  let decide=view.panel('today-decide')!;
  expect(row(decide,'l1')!.querySelector('[data-recommendation]')?.getAttribute('data-recommendation')).toBe('recommend_approve');
  expect(row(decide,'l2')!.querySelector('[data-recommendation]')?.getAttribute('data-recommendation')).toBe('needs_review');
  for(const id of ['a1','c1','l3'])expect(row(decide,id)!.querySelector('[data-recommendation]')).toBeNull();
  expect(within(view.container).queryByRole('button',{name:/^(approve|decline|review and approve)/i})).toBeNull();
  expect(decide.querySelector('[data-today-recommendation-note]')).not.toBeNull();
  cleanup();
  S.views=new Map();
  view=await show('manager');
  decide=view.panel('today-decide')!;
  expect(decide.querySelector('[data-recommendation]')).toBeNull();
  expect(decide.querySelector('[data-today-recommendation-note]')).toBeNull();
 });

 it('opens the recommendation the manager asked for in place, even past the first rows',async()=>{
  S.views=new Map<string,unknown>([['l9',{kind:'recommendation',verdict:'recommend_approve',failedRules:[]}]]);
  const view=await show('manager',false,{recommend:'l9'});
  const decide=view.panel('today-decide')!;
  const asked=row(decide,'l9')!;
  expect(asked.getAttribute('data-today-focus')).toBe('true');
  expect(asked.querySelector('[data-recommendation]')?.getAttribute('data-recommendation')).toBe('recommend_approve');
  expect(new Set(S.recommendCalls.map(ids=>ids.join(',')))).toEqual(new Set(['l1,l2,l3,l9']));
 });

 it('offers the team pages under Your workspace, mounts the Performance block, and keeps the manager\'s own record beside the team',async()=>{
  const view=await show('manager',false,{employmentId:'emp-own'});
  // The team workbench is retired (12 Nov 2026): its link now points at the team's own pages.
  expect(view.container.querySelector('[data-today-workbench]')).toBeNull();
  const workspace=view.container.querySelector('[data-today-workspace]')!;
  expect(workspace.getAttribute('aria-label')).toBe('Your workspace');
  const hrefs=[...workspace.querySelectorAll('a')].map(link=>link.getAttribute('href'));
  expect(hrefs.slice(0,2)).toEqual(['/manage/my-team','/approvals']);
  expect(hrefs.filter(href=>href?.includes('workspace='))).toEqual([]);
  expect(view.container.querySelector('[data-today-performance] [data-performance-home]')).not.toBeNull();
  expect(S.ownCalls).toContain('emp-own');
  const team=view.panel('today-team-coming-up')!;
  expect([...team.querySelectorAll('[data-today-team-line]')].map(line=>line.getAttribute('data-today-team-line'))).toEqual(['probation','cutoff']);
  expect(text(team)).toContain('Probation ends for Daniel Fictional on');
  expect(text(view.panel('today-own')!.querySelector('h2'))).toBe('For you');
 });

 it('keeps a panel that throws while it renders inside its own boundary',async()=>{
  S.throwPanel='DecidePanel';
  const spy=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
   const view=await show('manager');
   expect(view.panel('today-decide')).toBeNull();
   expect(text(view.container)).toContain('This could not be loaded just now. Its own page still works.');
   expect(view.panel('today-team-coming-up')).not.toBeNull();
   expect(view.panel('today-own')).not.toBeNull();
  }finally{spy.mockRestore();}
 });
});
