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
 queue:unknown;ask:boolean;own:unknown;ownReadiness:unknown;payHints:unknown;push:ReturnType<typeof vi.fn>;recommendCalls:string[][];views:Map<string,unknown>;
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
vi.mock('@/components/today/admin/reads',async()=>{
 const {rankedNeeds}=await import('../lib/today/admin');
 return {
  scopeKey:(ids:readonly string[])=>ids.join(','),
  readAdminNeeds:async()=>{if(S.needsFail)throw Error('Fixture needs outage');return {ranked:rankedNeeds(S.needs as never),failed:S.needsPartial};},
  readReadiness:async()=>S.readiness,
  readExceptions:async()=>S.exceptions,
  readHandled:async()=>{if(S.handledFail)throw Error('Fixture ledger outage');return S.handled;},
  readNeeds:async()=>S.queue,
 };
});
vi.mock('@/components/today/employee/reads',()=>({
 moduleState:()=>'on',readAskAllowed:async()=>S.ask,
 readOwnContext:async()=>S.own,readOwnReadiness:async()=>S.ownReadiness,readOwnPassportCards:async()=>[],readOwnPayHints:async()=>S.payHints,
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
  push:vi.fn(),recommendCalls:[],views:new Map(),
 });
 window.sessionStorage.clear();
});
afterEach(cleanup);

async function show(page:'admin'|'manager',all=false){
 const props={session:page==='admin'?ADMIN:MANAGER,scopeIds:['co-a','co-b'],allCompanies:true,now:NOW,all};
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
   ['answered','24 questions answered'],['leaveChecks','3 leave requests checked'],['loop:loop_missing_employee_data','186 Missing employee data: cases found 41 resolved'],
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

describe('Manager Today',()=>{
 beforeEach(()=>{
  S.queue={tasks:[task('c1','claim','2026-11-11T02:00:00Z','Arjun Fictional'),task('l2','leave','2026-11-10T02:00:00Z','Mei Fictional'),task('a1','attendance','2026-11-05T02:00:00Z','Wei Fictional'),
    task('l1','leave','2026-11-09T02:00:00Z','Aisyah Fictional'),task('p1','profile','2026-11-11T05:00:00Z','Ravi Fictional'),task('l3','leave','2026-11-12T01:00:00Z','Siti Fictional')],
   taskTotal:6,claimTotal:1,recommender:true,prepared:[],findings:[],taskLoops:{},failed:false,
   loops:[{kind:'probation',caseId:'case-1',name:'Daniel Fictional',endDate:'2026-11-20',stage:'with_manager',overdue:false,reviewId:null,href:'/admin/personnel/e9'}]};
  S.views=new Map<string,unknown>([['l1',{kind:'recommendation',verdict:'recommend_approve',failedRules:[]}],
   ['l2',{kind:'recommendation',verdict:'needs_review',failedRules:[{check:'team_coverage',blocking:false,version:null}]}]]);
 });

 it('lists decisions oldest first, with the heading and "See all" counting the same queue',async()=>{
  const view=await show('manager');
  expect(view.container.querySelector('[data-today="manager"]')).not.toBeNull();
  expect(text(view.container.querySelector('[data-today-date]'))).toBe('Thursday, November 12, 2026');
  expect(text(view.container.querySelector('[data-today-decision-count]'))).toBe('6 decisions for your team');
  const decide=view.panel('today-decide')!;
  expect([...decide.querySelectorAll('[data-today-task] > div > p:first-child')].map(text)).toEqual([
   'Review attendance correction · Wei Fictional','Approve leave request · Aisyah Fictional','Approve leave request · Mei Fictional',
   'Approve expense claim · Arjun Fictional','Verify profile change · Ravi Fictional']);
  expect(within(decide as HTMLElement).getByRole('link',{name:'See all 6'}).getAttribute('href')).toBe('/approvals');
  expect(view.container.querySelector('[data-today-more]')).toBeNull();
 });

 it('shows the leave recommendation inline on each leave decision only, read once for the leave rows shown, and decides nothing',async()=>{
  const view=await show('manager');
  // Only the leave rows shown are read (React's request memo makes it one read per render on the server).
  expect(S.recommendCalls.length).toBeGreaterThan(0);
  expect(new Set(S.recommendCalls.map(ids=>ids.join(',')))).toEqual(new Set(['l1,l2']));
  const decide=view.panel('today-decide')!;
  const row=(id:string)=>[...decide.querySelectorAll('[data-today-task]')].find(li=>li.querySelector('a')?.getAttribute('href')?.includes(`requestId=${id}`))!;
  expect(row('l1').querySelector('[data-recommendation]')?.getAttribute('data-recommendation')).toBe('recommend_approve');
  expect(row('l2').querySelector('[data-recommendation]')?.getAttribute('data-recommendation')).toBe('needs_review');
  for(const id of ['a1','c1','p1'])expect(row(id).querySelector('[data-recommendation]')).toBeNull();
  // The manager decides on the request's own page: no approve, decline or approve-all control on Today.
  expect(within(view.container).queryByRole('button',{name:/^(approve|decline|review and approve)/i})).toBeNull();
  expect(text(decide)).toContain('You still make every decision');
 });

 it('says what is coming up for the team, and keeps the manager\'s own record beside it',async()=>{
  const view=await show('manager');
  const team=view.panel('today-team-coming-up')!;
  expect([...team.querySelectorAll('[data-today-team-line]')].map(line=>line.getAttribute('data-today-team-line'))).toEqual(['probation','cutoff']);
  expect(text(team)).toContain('Probation ends for Daniel Fictional on');
  expect(text(team)).toContain('Decide overtime and claims before then.');
  expect(text(view.panel('today-own')!.querySelector('h2'))).toBe('For you');
 });
});
