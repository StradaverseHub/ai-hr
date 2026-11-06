/** AI v2 Phase 1, W3 — Today, rendered for each role from fictional owner fixtures.
 *
 * Every owner Today reads is replaced by a fixture that behaves like the owner on the one property under test (the
 * approvals queue answers only for the scope it is given; the passport follow-up owner answers for every company the
 * caller administers, so Today must narrow it; the outcome summary returns counts only). Expected text is written
 * out literally from the fixture, through the real English catalogue, never re-derived from Today's own helpers.
 * The streamed page is resolved the way the browser finally shows it (test/helpers/server-tree.ts). */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {withAiCentre} from './helpers/ai-centre-messages';
import {resolveServerTree} from './helpers/server-tree';

const fx=vi.hoisted(()=>{
 class FixtureHomeAccessError extends Error{constructor(readonly code:string){super(code);this.name='HomeAccessError';}}
 class FixtureEntitlementsResolutionFailedError extends Error{}
 const empty={answeredForYou:0,answeredForOthers:0,leaveChecks:0,preparedForYou:0};
 return {FixtureHomeAccessError,FixtureEntitlementsResolutionFailedError,empty,state:{} as {
  tasks:{id:string;kind:string;subjectName:string|null;createdAt:string;linkPath:string;companyId:string}[];tasksFail:boolean;claimTotal?:number;
  ownLeave:{actionId:string;state:string;createdAt:string;expiresAt:string}[];reopened:Record<string,unknown>;reopenCalls:string[];cancellations:{actionId:string;state:string;createdAt:string;expiresAt:string}[];
  decisions:{actionId:string;state:string;createdAt:string;expiresAt:string}[];
  proposals:{count:number}[];readiness:{employees:number;ready:number};digest:unknown;recommender:boolean;
  summary:typeof empty;summaryFail:boolean;worklist:Record<string,{status:string}[]>;exceptions:{rows:{disposition:string}[];total:number};
  passports:{itemId:string;employmentId:string;companyId:string;stage:string;waitingOn:string}[];
  timeOff:unknown;timeOffError:unknown;pay:unknown;payError:unknown;managers:{employmentId:string}[];calendarDays:unknown[];
  assistant:boolean;name:string|null;modules:Set<string>;entitlementsFail:boolean;push:ReturnType<typeof vi.fn>;
  loops:unknown[];loopsFail:boolean;
  /** AI v2 Phase 1 slice 3: letter requests waiting for HR, as the owner counts them for the viewer (generate holders only). */
  letterRequests:number;
  calls:{tasks:unknown[];worklist:string[];summary:unknown[];proposals:number;readiness:number;exceptions:number;passports:number;timeOff:unknown[];loops:unknown[];letters:unknown[]};
 }};
});
const S=fx.state;

vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const base=(await import('../messages/en.json')).default;
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const messages=merge('en',base);
 return {getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages,namespace:namespace as never}),getLocale:async()=>'en'};
});
vi.mock('next/navigation',()=>({useRouter:()=>({push:S.push}),usePathname:()=>'/'}));
vi.mock('@/db/client',()=>({withTenant:async(_s:unknown,run:(tx:unknown)=>unknown)=>run({})}));
// Today reads modules with the throwing check (test/module-catalog-drift.test.ts); an unresolved snapshot throws the
// resolution-failed error, as core/entitlements.ts does.
vi.mock('@/core/entitlements',()=>({EntitlementsResolutionFailedError:fx.FixtureEntitlementsResolutionFailedError,
 isModuleEnabled:(_s:unknown,code:string)=>{if(S.entitlementsFail)throw new fx.FixtureEntitlementsResolutionFailedError('Fixture snapshot outage');return S.modules.has(code);}}));
vi.mock('@/core/approvals-inbox',()=>{
 const listPendingTasks=async(_s:unknown,scope:string[])=>{S.calls.tasks.push(scope);if(S.tasksFail)throw Error('Fixture queue outage');
  return S.tasks.filter(task=>scope.includes(task.companyId)).map(({companyId:_companyId,...task})=>task);};
 return {listPendingTasks,pendingTaskSummary:async(s:unknown,scope:string[])=>{
  const items=await listPendingTasks(s,scope),claims=items.filter(task=>task.kind==='claim');let seen=0;
  return {items:items.filter(task=>task.kind!=='claim'||seen++<25),total:items.length-claims.length+(S.claimTotal??claims.length),claimTotal:S.claimTotal??claims.length};
 }};
});
// The owners' own reopen of the caller's review, as the review page reads it; a missing fixture is the owner refusing.
const reopen=async(id:string)=>{S.reopenCalls.push(id);if(!(id in S.reopened))throw Error('Fixture review unavailable');return S.reopened[id];};
vi.mock('@/core/assistant-actions/own-leave-store',()=>({listOwnLeaveReviewsTx:async()=>({kind:'review_index',reviews:S.ownLeave}),reopenOwnLeaveReviewTx:async(_tx:unknown,_s:unknown,id:string)=>reopen(id)}));
vi.mock('@/core/assistant-actions/leave-change-review-store',()=>({leaveCancellationReviews:{list:async()=>({kind:'leave_cancellation_review_index',reviews:S.cancellations}),reopen:async(_s:unknown,id:string)=>reopen(id)}}));
vi.mock('@/core/assistant-actions/leave-decision-review-store',()=>({listLeaveDecisionReviews:async()=>({kind:'leave_decision_review_index',reviews:S.decisions}),reopenLeaveDecisionReview:async(_s:unknown,id:string)=>reopen(id)}));
vi.mock('@/core/agent-actions',()=>({proposeActions:async()=>{S.calls.proposals++;return S.proposals;}}));
vi.mock('@/core/record-readiness',()=>({recordReadiness:async()=>{S.calls.readiness++;return S.readiness;}}));
// The digest owner's own pages (core/digest/daily-digest.ts DIGEST_PAGES; test/ai-centre-restructure.test.ts pins the setup page).
vi.mock('@/core/digest/daily-digest',()=>({DIGEST_PAGES:{approvals:'/approvals',setup:'/payroll/setup?readiness=full',deadlines:'/payroll/statutory-forms'},latestDailyDigest:async()=>S.digest}));
vi.mock('@/core/agent-registry/controls',()=>({workerRunGate:async()=>({run:S.recommender})}));
vi.mock('@/core/recommenders/leave-decision',()=>({RECOMMENDER_WORKER:'approver_recommendation'}));
// The approver recommendation the person asked to open (the retired Inbox's in-place panel, now on Today).
const recommendation=vi.hoisted(()=>({read:vi.fn(async(_session:unknown,_leaveRequestId:string)=>({kind:'recommendation',verdict:'recommend_approve',failedRules:[]}))}));
vi.mock('@/app/assistant/centre/recommendation',()=>({readLeaveRecommendation:recommendation.read}));
vi.mock('@/core/outcome-record/summary',()=>({summariseOutcomeRecords:async(_s:unknown,p:unknown)=>{S.calls.summary.push(p);if(S.summaryFail)throw Error('Fixture record outage');return S.summary;}}));
vi.mock('@/core/reporting',()=>({complianceWorklist:async(_s:unknown,p:{companyId:string})=>{S.calls.worklist.push(p.companyId);return S.worklist[p.companyId]??[];}}));
// The reader counts blocking exceptions over the whole queue (its own count, not the page's rows: Today fix d).
vi.mock('@/core/payroll-anomaly',()=>({openExceptionsAcrossRuns:async()=>{S.calls.exceptions++;return {...S.exceptions,blocking:S.exceptions.rows.filter(row=>row.disposition==='block').length,cappedOut:false};}}));
// The letter request owner counts only requests in companies where the viewer holds the letters `generate` capability.
vi.mock('@/core/letter-requests',()=>({countWaitingLetterRequests:async(_s:unknown,scope:readonly string[])=>{S.calls.letters.push([...scope]);return S.letterRequests;}}));
vi.mock('@/core/automatic-followups',()=>({followupItemsTx:async()=>{S.calls.passports++;return S.passports;}}));
// AI v2 W8: the loops' open cards, as core/loops/cards.ts reads them for this viewer (row-level security decides whose).
// AI v2 W8: Confirm on the missed clock-out card posts the case, the person's reason option and, for Other, their words.
const clockOut=vi.hoisted(()=>({posts:[] as unknown[],result:{kind:'submitted'} as unknown}));
vi.mock('@/app/assistant/loop-clock-out-actions',()=>({confirmMissedClockOutAction:async(input:unknown)=>{clockOut.posts.push(input);return clockOut.result;}}));
vi.mock('@/app/assistant/payroll-readiness-actions',()=>({answerTp3PreviousEmployerAction:vi.fn()}));
// AI v2 Phase 2 P2-3: the Before payroll card has its own DOM test (test/before-payroll.dom.test.tsx); here it reads nothing.
vi.mock('@/core/pre-salary/person-items',()=>({readMyPayrollReadiness:async()=>null}));
// AI v2 Phase 2 P2-1: the Undo on a clock-out the loop set (covered by test/teras-loop-autonomy-pages.dom.test.tsx).
vi.mock('@/app/assistant/loop-undo-actions',()=>({undoOwnLoopAction:async()=>({kind:'refused',reason:'unavailable'})}));
vi.mock('@/core/loops/cards',()=>({readLoopCards:async(_s:unknown,p:unknown)=>{S.calls.loops.push(p);if(S.loopsFail)throw Error('Fixture loop outage');return S.loops;}}));
vi.mock('@/core/employee-home-time-off',()=>({readEmployeeHomeTimeOff:async(_s:unknown,employmentId?:string)=>{S.calls.timeOff.push(employmentId);if(S.timeOffError)throw S.timeOffError;return S.timeOff;}}));
vi.mock('@/core/employee-home',()=>({HomeAccessError:fx.FixtureHomeAccessError,
 readEmployeeHomePayHints:async()=>{if(S.payError)throw S.payError;return S.pay;},
 readEmployeeHomeGreetingIdentity:async()=>{if(S.name===null)throw new fx.FixtureHomeAccessError('chooseEmployment');return {version:1,employmentId:'emp-own',name:S.name,photoHref:null};}}));
vi.mock('@/core/employee-home-sharing',()=>({readHomeTeamCalendar:async()=>({scope:'company',from:'2026-11-04',to:'2026-11-17',days:S.calendarDays})}));
vi.mock('@/core/read',()=>({reportingLinesFor:async()=>({managers:S.managers,reports:[]})}));
vi.mock('@/core/assistant-grant',()=>({mayUseAssistant:async()=>({allowed:S.assistant})}));
vi.mock('@/lib/viewer',()=>({viewerIdentity:async()=>({name:'Aisyah Fictional',employeeCode:null,employed:false})}));
// AI v2 W5: the leave dashboard card's explanation behind a balance's Why?, as core/explainers/own-why.ts reads it as the viewer.
const why=vi.hoisted(()=>({calls:[] as unknown[]}));
// Slice 3 follow-up: the payslip row's Why? reads the payslip's own detail (the payslip screen's own-only read), then the
// person's own released payslips through the real comparison owner. October is September less one day's unpaid leave.
const pay=vi.hoisted(()=>({detailCalls:[] as unknown[],differenceCalls:[] as unknown[],detail:null as null|{companyId:string;payPeriod:string;currency:string|null}}));
vi.mock('@/packs/payroll/service',()=>({myPayslipDetail:async(_s:unknown,id:string)=>{pay.detailCalls.push(id);return id==='ps-oct'?pay.detail:null;}}));
vi.mock('@/core/explainers/own-why',async()=>{
 const {comparePayPeriods}=await import('../core/pay-difference');
 const stat=(over:Record<string,unknown>={})=>({version:'my-2026.1',epfEmployee:550,epfEmployer:650,socsoEmployee:24.75,socsoEmployer:86.65,socsoSkbbk:0,eisEmployee:9.9,eisEmployer:9.9,pcb:120,hrdf:0,
  bases:{epf:5000,epfAdditional:0,socsoEis:5000,pcb:5000,hrdf:5000},salaryBasis:{version:1,basicSalary:5000,effectiveFrom:'2024-01-01'},...over});
 const row=(over:Record<string,unknown>)=>({companyId:'co-a',company:'Fictional Ceria Sdn Bhd',payPeriod:'2026-09',runType:'regular',runSeq:1,basic:'5000.00',allowance:'0.00',overtime:'0.00',
  bonus:'0.00',gross:'5000.00',statutory:stat(),otherDeductions:'0.00',totalDeductions:'704.65',net:'4295.35',daysWorked:'30.00',...over});
 const OCTOBER=row({payPeriod:'2026-10',otherDeductions:'230.77',totalDeductions:'892.02',net:'4107.98',
  statutory:stat({epfEmployee:528,socsoEmployee:23.75,eisEmployee:9.5,pcb:100,unpaidLeave:{days:1,amount:230.77},bases:{epf:4769.23,epfAdditional:0,socsoEis:4769.23,pcb:4769.23,hrdf:4769.23}})});
 return {ownPayDifference:async(_s:unknown,input:{companyId:string;period:string})=>{pay.differenceCalls.push(input);return comparePayPeriods([OCTOBER,row({})] as never,input);},
 ownLeaveBalanceWhy:async(_s:unknown,input:unknown)=>{why.calls.push(input);return {leaveType:'Annual Leave',cycleStart:'2026-01-01',cycleEnd:'2026-12-31',
 isCurrentCycle:true,canApplyFor:9.5,entitlementTemplateName:'Fictional Standard',entitlementStatus:'generated',withheld:false,carryForwardExpiryDate:null,proration:null,
 figures:{entitlement:14,earnedSoFar:12,broughtForward:0,adjustments:0,totalEntitlement:14,taken:3.5,pending:1,forfeited:0,available:9.5}};}};});

import {TodayPage} from '../components/today/today-page';
import {ASK_HANDOFF_KEY} from '../lib/today/ask-handoff';

const messages=withAiCentre('en',en);
// 09:30 on Wednesday 4 November 2026 in Malaysia.
const NOW=new Date('2026-11-04T01:30:00Z');
const FUTURE='2099-01-01T00:00:00.000Z';
const ctx=(roles:string[],grants:{role:string;companyId:string|null}[]=[])=>({tenantId:'fictional-tenant',userId:'fictional-login',personId:'fictional-person',roles,grants,
 entitlements:{tenantId:'fictional-tenant',enabledModules:[],scopedModules:{},settings:{},tenantStatus:'active'}}) as never;
const EMPLOYEE=ctx(['employee']);
const MANAGER=ctx(['manager']);
const HR_ADMIN=ctx(['hr_admin'],[{role:'hr_admin',companyId:'co-a'}]);
const GROUP_ADMIN=ctx(['hr_admin'],[{role:'hr_admin',companyId:null}]);
const PAYROLL_PARTNER=ctx(['payroll_partner'],[{role:'payroll_partner',companyId:'co-a'}]);
const text=(el:Element|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();

beforeEach(()=>{
 Object.assign(S,{tasks:[],tasksFail:false,claimTotal:undefined,ownLeave:[],reopened:{},reopenCalls:[],cancellations:[],decisions:[],proposals:[],readiness:{employees:0,ready:0},digest:null,recommender:false,
  summary:{...fx.empty},summaryFail:false,worklist:{},exceptions:{rows:[],total:0},passports:[],timeOff:{version:1,employmentId:'emp-own',asOf:'2026-11-04',canApply:true,balances:[],nextApproved:null},
  timeOffError:null,pay:{version:1,employmentId:'emp-own',payslips:[],nextPayment:null},payError:null,managers:[],calendarDays:[],assistant:true,name:'Ravi Fictional',
  modules:new Set(['leave','payroll','attendance','claims','performance','rewards']),entitlementsFail:false,push:vi.fn(),loops:[],loopsFail:false,letterRequests:0,
  calls:{tasks:[],worklist:[],summary:[],proposals:0,readiness:0,exceptions:0,passports:0,timeOff:[],loops:[],letters:[]}});
 window.sessionStorage.clear();
});
afterEach(cleanup);

async function show(session:never,scopeIds:string[],employmentId?:string,needs?:{all?:boolean;recommend?:string},why_?:string){
 const tree=await resolveServerTree(await TodayPage({session,scopeIds,employmentId,needs,why:why_,now:NOW,more:<p data-fixture-more>Existing dashboard</p>}));
 const view=render(<NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">{tree}</NextIntlClientProvider>);
 const section=(id:string)=>view.container.querySelector(`[data-today-section="${id}"]`);
 return {...view,section};
}

describe('Today for an employee',()=>{
 beforeEach(()=>{
  S.tasks=[{id:'notice-1',kind:'noticeAcknowledgement',subjectName:null,createdAt:'2026-11-03T02:00:00Z',linkPath:'/notices/notice-1',companyId:'co-a'}];
  S.ownLeave=[
   {actionId:'11111111-1111-4111-8111-111111111111',state:'awaiting_confirmation',createdAt:'2026-11-04T00:12:00.000Z',expiresAt:FUTURE},
   {actionId:'22222222-2222-4222-8222-222222222222',state:'completed',createdAt:'2026-11-01T00:00:00.000Z',expiresAt:FUTURE},
   {actionId:'33333333-3333-4333-8333-333333333333',state:'awaiting_confirmation',createdAt:'2020-01-01T00:00:00.000Z',expiresAt:'2020-01-02T00:00:00.000Z'},
  ];
  S.reopened={'11111111-1111-4111-8111-111111111111':{kind:'prepared',review:{actionId:'11111111-1111-4111-8111-111111111111',contractVersion:1,
   reviewedDigest:'a'.repeat(64),humanIntentDigest:'b'.repeat(64),createdAt:'2026-11-04T00:12:00.000Z',expiresAt:FUTURE,companyName:'Fictional Sdn Bhd',employeeCode:'F-1',
   leaveTypeName:'Annual Leave',date:'2026-11-05',durationType:'full_day',deductionDays:1,availableBalance:null,estimatedAvailableAfter:null,holidayWarnings:[],approvalRouting:'unknown',humanText:{}}}};
  S.summary={...fx.empty,answeredForYou:3};
  S.timeOff={version:1,employmentId:'emp-own',asOf:'2026-11-04',canApply:true,nextApproved:null,
   balances:[{id:'lt-al',name:'Annual Leave',annualLeave:true,available:9.5,pending:0},{id:'lt-ml',name:'Medical Leave',annualLeave:false,available:11.5,pending:null}]};
  S.pay={version:1,employmentId:'emp-own',nextPayment:null,payslips:[{id:'ps-oct',period:'2026-10',runType:'regular',runSequence:1},{id:'ps-sep',period:'2026-09',runType:'regular',runSequence:1}]};
  S.managers=[{employmentId:'emp-siti'}];
  S.calendarDays=[
   {date:'2026-11-04',available:true,totalPeople:0,items:[],nextCursor:null},
   {date:'2026-11-06',available:true,totalPeople:2,items:[{employmentId:'emp-siti',name:'Siti Fictional'},{employmentId:'emp-peer',name:'Peer Fictional'}],nextCursor:null},
   {date:'2026-11-07',available:true,totalPeople:1,items:[{employmentId:'emp-siti',name:'Siti Fictional'}],nextCursor:null},
   {date:'2026-11-10',available:true,totalPeople:1,items:[{employmentId:'emp-siti',name:'Siti Fictional'}],nextCursor:null},
  ];
 });

 it('greets the person by name on the HR date and offers the Ask bar with the four suggestions, the letter one a link to its form',async()=>{
  const view=await show(EMPLOYEE,['co-a']);
  expect(text(view.section('today-needs-you')!.querySelector('h2'))).toBe('Ready for you to confirm');
  expect(text(view.container.querySelector('h1'))).toBe('Good morning, Ravi');
  expect(text(view.container.querySelector('[data-today-date]'))).toBe('Wednesday, November 4, 2026');
  expect(view.container.querySelector('[data-today-date]')?.getAttribute('data-today-date')).toBe('2026-11-04');
  const ask=view.container.querySelector('[data-today-ask]')!;
  expect(within(ask as HTMLElement).getByPlaceholderText('Ask AI Centre: leave, pay, claims, anything about work…')).toBeTruthy();
  expect([...ask.querySelectorAll('[role="group"] button')].map(text)).toEqual(['Apply for leave','Submit a claim','Why is my pay different?']);
  // The letter chip opens Request a letter on My Letters, and fills nothing in the box.
  const letter=within(ask.querySelector('[role="group"]') as HTMLElement).getByRole('link',{name:'Get an employment letter'});
  expect(letter.getAttribute('href')).toBe('/me/letters?request=1');expect(letter.hasAttribute('data-today-suggestion-link')).toBe(true);
  expect([...ask.querySelectorAll('[role="group"] > *')].map(text)).toEqual(['Apply for leave','Submit a claim','Why is my pay different?','Get an employment letter']);
  expect(view.container.querySelector('[data-today="personal"]')).not.toBeNull();
  expect(view.section('today-watching')).toBeNull();
 });

 it('lists only the live prepared proposal and the own task, each with its one action',async()=>{
  const view=await show(EMPLOYEE,['co-a']);
  const needs=view.section('today-needs-you')!;
  expect(text(needs.querySelector('[data-today-count]'))).toBe('2');
  const prepared=needs.querySelectorAll('[data-today-prepared]');
  expect(prepared).toHaveLength(1);
  // Named the way the chat card names it, from the owner's reopen of this person's own review.
  expect(text(prepared[0].querySelector('h3'))).toBe('Annual Leave, Thu, Nov 5 (1 day)');
  expect(text(prepared[0])).toContain('Leave application prepared for you');
  expect(text(prepared[0])).toContain('Prepared Nov 4, 2026, 8:12 AM');
  expect(S.reopenCalls).toEqual(['11111111-1111-4111-8111-111111111111']);
  expect(text(prepared[0])).toContain('Nothing is submitted until you confirm.');
  const links=prepared[0].querySelectorAll('a');
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute('href')).toBe('/assistant/leave?review=11111111-1111-4111-8111-111111111111');
  expect(text(links[0])).toBe('Review and confirm · Annual Leave, Thu, Nov 5 (1 day)');
  const task=needs.querySelector('[data-today-task="noticeAcknowledgement"]')!;
  expect(text(task.querySelector('h3'))).toBe('Acknowledge notice');
  expect(text(task)).toContain('Received Nov 3, 2026');
  // The Review link carries the allow-listed Today origin, so the page offers "Back to Today".
  expect(task.querySelector('a')?.getAttribute('href')).toBe('/notices/notice-1?from=today');
 });

 it('counts what AI Centre answered for the person, and shows nothing else from the record',async()=>{
  const view=await show(EMPLOYEE,['co-a']);
  const done=view.section('today-done-for-you')!;
  expect([...done.querySelectorAll('[data-today-note]')].map(note=>[note.getAttribute('data-today-note'),...[...note.children].map(text)])).toEqual([
   ['answeredYou','Answered','Answered 3 of your questions','In the last 7 days.'],
  ]);
  expect(S.calls.summary).toEqual([{since:new Date('2026-10-28T16:00:00.000Z'),companyIds:['co-a']}]);
 });

 it('shows At a glance: balances with Why?, the latest payslip and the manager\'s absence only',async()=>{
  const view=await show(EMPLOYEE,['co-a']);
  const glance=view.section('today-at-a-glance')!;
  expect([...glance.querySelectorAll('[data-today-balance]')].map(row=>[text(row.querySelector('dt')),text(row.querySelector('b')),row.querySelector('a')?.getAttribute('href')]))
   // AI v2 W5: Why? opens the balance's explanation in place on Today (test/why-panels.dom.test.tsx), no longer Leave Details.
   .toEqual([['Annual Leave','9.50 days','/?why=leave%3Alt-al'],['Medical Leave','11.50 days','/?why=leave%3Alt-ml']]);
  // AI v2 W5: the link's accessible name says which balance it explains; the visible word is Why?.
  expect(text(glance.querySelector('[data-today-balance] a'))).toBe('Why?');
  expect(glance.querySelector('[data-today-balance] a')?.getAttribute('aria-label')).toBe('Why? Why is my Annual Leave balance this figure?');
  const payslip=glance.querySelector('[data-today-payslip]')!;
  expect(text(payslip.querySelector('dt'))).toBe('October 2026 payslip');
  expect(payslip.querySelector('a:not([data-why-link])')?.getAttribute('href')).toBe('/me/payslip?year=2026&month=10&payslipId=ps-oct');
  // Slice 3 follow-up: the payslip row has its own Why?, closed until asked for.
  const payWhy=payslip.querySelector('[data-why-link]')!;
  expect([text(payWhy),payWhy.getAttribute('href'),payWhy.getAttribute('aria-label'),payWhy.getAttribute('aria-expanded')])
   .toEqual(['Why?','/?why=pay','Why? Why is my pay different from last month?','false']);
  expect(payslip.querySelector('[data-why-panel]')).toBeNull();
  expect([...glance.querySelectorAll('[data-today-away]')].map(text)).toEqual([
   'Siti Fictional, your manager, is away Fri, Nov 6 – Sat, Nov 7.',
   'Siti Fictional, your manager, is away on Tue, Nov 10.',
  ]);
  // A colleague on the same team calendar is not this person's manager and is not named.
  expect(text(glance)).not.toContain('Peer Fictional');
 });

 it('opens a balance\'s Why? in place under its row, from the leave service\'s own figures, with Ask AI Centre',async()=>{
  why.calls.length=0;
  const view=await show(EMPLOYEE,['co-a'],undefined,undefined,'leave:lt-al');
  const [annual,medical]=[...view.section('today-at-a-glance')!.querySelectorAll('[data-today-balance]')];
  // The open row's link now closes the panel; the other row still opens its own.
  expect(annual.querySelector('a')?.getAttribute('href')).toBe('/');expect(annual.querySelector('a')?.getAttribute('aria-expanded')).toBe('true');
  expect(medical.querySelector('a')?.getAttribute('href')).toBe('/?why=leave%3Alt-ml');expect(medical.querySelector('[data-why-panel]')).toBeNull();
  const panel=annual.querySelector('[data-today-why] [data-why-panel="leave"]')!;
  expect(text(panel.querySelector('h3'))).toBe('Your Annual Leave balance');
  expect([...panel.querySelectorAll('[data-why-figures] > div')].map(div=>[text(div.querySelector('dt')),text(div.querySelector('dd'))])).toEqual([
   ['Entitlement for the year','14.00 days'],['Earned so far','12.00 days'],['Carried forward','0.00 days'],['Adjustments','0.00 days'],['Total entitlement','14.00 days'],
   ['Taken','3.50 days'],['Waiting for approval','1.00 days'],['Available','9.50 days']]);
  // The figure beside Why? is the figure the panel ends on.
  expect(text(annual.querySelector('b'))).toBe('9.50 days');
  expect(why.calls).toEqual([{leaveTypeId:'lt-al',employmentId:undefined,locale:'en'}]);
  fireEvent.click(within(panel as HTMLElement).getByRole('button',{name:'Ask AI Centre about this'}));
  expect(JSON.parse(window.sessionStorage.getItem(ASK_HANDOFF_KEY)!).q).toBe('Why is my Annual Leave balance what it is?');
  expect(S.push).toHaveBeenCalledWith('/assistant');
  // Someone the Assistant cannot answer still sees the figures, with no Ask.
  cleanup();S.assistant=false;
  const quiet=await show(EMPLOYEE,['co-a'],undefined,undefined,'leave:lt-al');
  expect(quiet.container.querySelector('[data-why-panel="leave"]')).not.toBeNull();expect(quiet.container.querySelector('[data-why-ask]')).toBeNull();
  // A Why? for a type the person does not hold on Today reads nothing.
  cleanup();why.calls.length=0;S.assistant=true;
  await show(EMPLOYEE,['co-a'],undefined,undefined,'leave:not-theirs');
  expect(why.calls).toEqual([]);
 });

 it('opens the payslip row\'s Why? in place: the payslip screen\'s pay-difference panel for that payslip, in its company\'s currency',async()=>{
  pay.detailCalls.length=0;pay.differenceCalls.length=0;pay.detail={companyId:'co-a',payPeriod:'2026-10',currency:'MYR'};
  const view=await show(EMPLOYEE,['co-a'],undefined,undefined,'pay');
  const row=view.section('today-at-a-glance')!.querySelector('[data-today-payslip]')!;
  const link=row.querySelector('[data-why-link]')!;
  expect([link.getAttribute('href'),link.getAttribute('aria-expanded'),link.getAttribute('aria-controls')]).toEqual(['/','true','today-why-pay']);
  const panel=row.querySelector('[data-today-why="pay"] [data-why-panel="pay"]')!;
  expect(panel.id).toBe('today-why-pay');
  expect(text(panel.querySelector('[data-why-lead]'))).toBe('Your net pay was MYR 187.37 lower than in September 2026.');
  expect(text(panel)).toContain('MYR 230.77');
  expect(pay.detailCalls).toEqual(['ps-oct']);expect(pay.differenceCalls).toEqual([{companyId:'co-a',period:'2026-10'}]);
  // No balance panel opens with it, and Close returns to Today.
  expect(view.container.querySelector('[data-why-panel="leave"]')).toBeNull();
  expect(panel.querySelector('[data-why-close]')?.getAttribute('href')).toBe('/');
  fireEvent.click(within(panel as HTMLElement).getByRole('button',{name:'Ask AI Centre about this'}));
  expect(S.push).toHaveBeenCalledWith('/assistant');
  // A payslip the person cannot open shows the quiet line, never a guessed figure.
  cleanup();pay.detailCalls.length=0;pay.differenceCalls.length=0;pay.detail=null;
  const missing=await show(EMPLOYEE,['co-a'],undefined,undefined,'pay');
  expect(missing.container.querySelector('[data-today-why="pay"] [data-why-unavailable]')).not.toBeNull();
  expect(missing.container.querySelector('[data-why-panel]')).toBeNull();expect(pay.differenceCalls).toEqual([]);
  // Without payroll in use there is no payslip row and nothing is read.
  cleanup();pay.detailCalls.length=0;S.modules.delete('payroll');
  const none=await show(EMPLOYEE,['co-a'],undefined,undefined,'pay');
  expect(none.container.querySelector('[data-today-payslip]')).toBeNull();expect(pay.detailCalls).toEqual([]);
 });

 it('keeps a manager\'s absence when their sharing choice withholds the name, without inventing one',async()=>{
  S.calendarDays=[{date:'2026-11-06',available:true,totalPeople:1,items:[{employmentId:'emp-siti',name:null}],nextCursor:null}];
  const view=await show(EMPLOYEE,['co-a']);
  expect([...view.section('today-at-a-glance')!.querySelectorAll('[data-today-away]')].map(text)).toEqual(['Your manager is away on Fri, Nov 6.']);
 });

 it('keeps the generic title when the owner refuses to reopen a review, and the cancellation kind still names itself',async()=>{
  S.ownLeave=[];
  S.cancellations=[{actionId:'55555555-5555-4555-8555-555555555555',state:'awaiting_confirmation',createdAt:'2026-11-04T00:30:00.000Z',expiresAt:FUTURE},
   {actionId:'66666666-6666-4666-8666-666666666666',state:'awaiting_confirmation',createdAt:'2026-11-04T00:40:00.000Z',expiresAt:'2098-01-01T00:00:00.000Z'}];
  S.reopened={'66666666-6666-4666-8666-666666666666':{kind:'prepared',review:{action:'leave.cancel',contractVersion:1,actionId:'66666666-6666-4666-8666-666666666666',reviewedDigest:'c'.repeat(64),
   createdAt:'2026-11-04T00:40:00.000Z',expiresAt:'2098-01-01T00:00:00.000Z',content:{action:'leave.cancel',contractVersion:1,employmentId:'77777777-7777-4777-8777-777777777777',leaveRequestId:'88888888-8888-4888-8888-888888888888',cancel:true},
   review:{employmentId:'77777777-7777-4777-8777-777777777777',leaveRequestId:'88888888-8888-4888-8888-888888888888',leaveTypeName:'Medical Leave',startDate:'2026-11-09',endDate:'2026-11-10',days:2,reason:null,employeeRemark:null},
   consequence:'pending_leave_withdrawn'}}};
  const view=await show(EMPLOYEE,['co-a']);
  const cards=[...view.container.querySelectorAll('[data-today-prepared="leaveCancel"]')];
  // Soonest expiry first: the reopened one, then the one its owner refused.
  expect(cards.map(card=>text(card.querySelector('h3')))).toEqual(['Medical Leave, Mon, Nov 9 – Tue, Nov 10 (2 days)','Leave cancellation prepared for you']);
  expect(text(cards[0])).toContain('Leave cancellation prepared for you');
  expect(cards[0].querySelector('a')?.getAttribute('href')).toBe('/assistant/leave?flow=change&action=leave.cancel&review=66666666-6666-4666-8666-666666666666');
 });

 it('runs no administrator read and keeps the existing dashboard under More',async()=>{
  const view=await show(EMPLOYEE,['co-a']);
  expect(S.calls).toMatchObject({proposals:0,readiness:0,exceptions:0,passports:0,worklist:[]});
  const more=view.container.querySelector('[data-today-more]')!;
  expect(text(more.querySelector('h2'))).toBe('More');
  expect(more.querySelector('[data-fixture-more]')).not.toBeNull();
  // The dashboard comes after every Today section.
  const order=[...view.container.querySelectorAll('[data-today-section],[data-today-more]')].map(el=>el.getAttribute('data-today-section')??'more');
  expect(order).toEqual(['today-needs-you','today-done-for-you','today-at-a-glance','more']);
 });

 it('Ask hands the typed question to AI Centre Ask without putting it in the address',async()=>{
  const view=await show(EMPLOYEE,['co-a']);
  const input=view.container.querySelector('[data-today-ask] input')! as HTMLInputElement;
  fireEvent.click(within(view.container.querySelector('[data-today-ask]') as HTMLElement).getByText('Why is my pay different?'));
  expect(input.value).toBe('Why is my pay different?');
  // A chip only fills the box.
  expect(S.push).not.toHaveBeenCalled();
  fireEvent.submit(input.closest('form')!);
  expect(S.push).toHaveBeenCalledWith('/assistant');
  expect(JSON.parse(window.sessionStorage.getItem(ASK_HANDOFF_KEY)!)).toMatchObject({q:'Why is my pay different?'});
 });

 it('offers no Ask bar to someone the Assistant cannot answer',async()=>{
  S.assistant=false;
  const view=await show(EMPLOYEE,['co-a']);
  expect(view.container.querySelector('[data-today-ask]')).toBeNull();
 });
});

describe('Today for a manager',()=>{
 it('puts the team\'s leave decision in Needs you with the recommendation only while its worker may run',async()=>{
  S.tasks=[{id:'lr-aminah',kind:'leave',subjectName:'Fictional Aminah',createdAt:'2026-11-02T02:00:00Z',linkPath:'/approvals?tab=leave',companyId:'co-a'}];
  S.decisions=[{actionId:'44444444-4444-4444-8444-444444444444',state:'awaiting_confirmation',createdAt:'2026-11-04T01:00:00.000Z',expiresAt:FUTURE}];
  S.reopened={'44444444-4444-4444-8444-444444444444':{kind:'prepared',review:{action:'approvals.leave.decide',contractVersion:1,actionId:'44444444-4444-4444-8444-444444444444',reviewedDigest:'d'.repeat(64),
   createdAt:'2026-11-04T01:00:00.000Z',expiresAt:FUTURE,content:{action:'approvals.leave.decide',contractVersion:1,leaveRequestId:'99999999-9999-4999-8999-999999999999',currentStepId:null,decision:'approved',rejectReason:null,confirmAssignedDecision:true},
   review:{leaveRequestId:'99999999-9999-4999-8999-999999999999',employmentId:'77777777-7777-4777-8777-777777777777',leaveTypeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',leaveTypeName:'Annual Leave',
    startDate:'2026-11-09',endDate:'2026-11-11',days:'3',durationType:'full_day',hours:null,fromTime:null,toTime:null,applicantReason:null,employeeRemark:null,currentStepId:null,stepIndex:null,
    decision:'approved',rejectReason:null,outcome:'approval_if_native_checks_pass'},consequence:'assigned_decision_request_may_remain_pending'}}};
  S.summary={...fx.empty,leaveChecks:2};
  S.recommender=true;
  let view=await show(MANAGER,['co-a']);
  const task=view.container.querySelector('[data-today-task="leave"]')!;
  expect(text(task.querySelector('h3'))).toBe('Approve leave request · Fictional Aminah');
  expect(task.querySelector('a[href="/approvals?tab=leave&from=today"]')).not.toBeNull();
  // The recommendation opens on Today itself (the AI Centre Inbox that showed it is retired).
  expect(task.querySelector('a[data-recommendation-loader]')?.getAttribute('href')).toBe('/?recommend=lr-aminah');
  expect(recommendation.read).not.toHaveBeenCalled();
  const decision=view.container.querySelector('[data-today-prepared="leaveDecision"]')!;
  expect(text(decision.querySelector('h3'))).toBe('Annual Leave, Mon, Nov 9 – Wed, Nov 11 (3 days)');
  expect(text(decision)).toContain('Leave decision prepared for you');
  expect(text(view.section('today-needs-you')!.querySelector('h2'))).toBe('Needs you');
  expect(decision.querySelector('a')?.getAttribute('href')).toBe('/assistant/approvals?review=44444444-4444-4444-8444-444444444444');
  expect(text(view.section('today-done-for-you')!.querySelector('[data-today-note="leaveChecks"] h3'))).toBe('Checked 2 leave requests for you');
  expect(view.section('today-at-a-glance')).not.toBeNull();
  cleanup();
  S.recommender=false;
  view=await show(MANAGER,['co-a']);
  expect(view.container.querySelector('a[data-recommendation-loader]')).toBeNull();
 });
});

describe('Today keeps what the retired AI Centre Inbox showed',()=>{
 const tasks=(n:number)=>Array.from({length:n},(_,i)=>({id:`lr-${i}`,kind:'leave',subjectName:`Fictional ${i}`,createdAt:'2026-11-02T02:00:00Z',linkPath:`/approvals?tab=leave&id=lr-${i}`,companyId:'co-a'}));
 it('lists the first five decisions with "See all", and every decision on /?needs=all',async()=>{
  S.tasks=tasks(7);
  let view=await show(MANAGER,['co-a']);
  expect(view.container.querySelectorAll('[data-today-task]')).toHaveLength(5);
  const seeAll=[...view.container.querySelectorAll('a')].find(link=>link.getAttribute('href')==='/?needs=all');
  expect(text(seeAll)).toContain('7');
  expect(view.container.querySelector('a[href*="view=inbox"]')).toBeNull();
  cleanup();
  view=await show(MANAGER,['co-a'],undefined,{all:true});
  expect([...view.container.querySelectorAll('[data-today-task] h3')].map(text)).toEqual(tasks(7).map(task=>`Approve leave request · ${task.subjectName}`));
  expect(view.container.querySelector('a[href="/?needs=all"]')).toBeNull();
 });
 it('opens the recommendation the approver asked for in place, only for a leave request in their own queue while the worker may run',async()=>{
  S.tasks=tasks(7);S.recommender=true;
  let view=await show(MANAGER,['co-a'],undefined,{recommend:'lr-6'});
  // The sixth-and-later card is shown when it is the one asked for.
  const row=view.container.querySelector('[data-recommendation]')!;
  expect(row.getAttribute('data-recommendation')).toBe('recommend_approve');
  expect(row.id).toBe('recommendation-lr-6');
  expect(recommendation.read).toHaveBeenCalledTimes(1);expect(recommendation.read.mock.calls[0][1]).toBe('lr-6');
  expect(view.container.querySelectorAll('a[data-recommendation-loader]')).toHaveLength(6);
  cleanup();recommendation.read.mockClear();
  // Not in the viewer's queue, or the worker switched off: nothing is read and only the links remain.
  view=await show(MANAGER,['co-a'],undefined,{recommend:'lr-foreign'});
  expect(view.container.querySelector('[data-recommendation]')).toBeNull();
  cleanup();S.recommender=false;
  view=await show(MANAGER,['co-a'],undefined,{recommend:'lr-1'});
  expect(view.container.querySelector('[data-recommendation]')).toBeNull();
  expect(recommendation.read).not.toHaveBeenCalled();
 });
 // Moved from the retired Inbox's component tests (test/ai-centre-step5-evidence.dom.test.tsx), now asserted on Today.
 it('names each failed rule with its version label and never a reject verdict, under its own row and focused',async()=>{
  S.tasks=[{id:'lr-aminah',kind:'leave',subjectName:'Fictional Aminah',createdAt:'2026-11-02T02:00:00Z',linkPath:'/approvals?tab=leave&id=lr-aminah',companyId:'co-a'}];S.recommender=true;
  recommendation.read.mockResolvedValueOnce({kind:'recommendation',verdict:'needs_review',failedRules:[{check:'balance_covers',blocking:true,version:{kind:'leave_type',version:3}},{check:'team_coverage',blocking:false,version:null}]} as never);
  const view=await show(MANAGER,['co-a'],undefined,{recommend:'lr-aminah'});
  const panel=view.container.querySelector('[data-recommendation]') as HTMLElement;
  expect(panel.getAttribute('data-recommendation')).toBe('needs_review');
  expect(within(panel).getByText('Needs your review')).toBeInTheDocument();
  expect(within(panel).getByText('The balance does not cover the days requested')).toBeInTheDocument();
  expect(within(panel).getByText('A leave rule would refuse this request as it stands.')).toBeInTheDocument();
  expect(within(panel).getByText('Leave type rules, version 3')).toBeInTheDocument();
  expect(within(panel).getByText('Team coverage on these dates')).toBeInTheDocument();
  expect(within(panel).getAllByText(/version/)).toHaveLength(1);
  expect(panel.textContent).not.toMatch(/reject/i);
  // Advice only: the decision card beside it decides nothing here, and the panel opens under its own row with focus.
  const row=panel.closest('li')!;
  expect(row.getAttribute('data-today-task')).toBe('leave');
  expect(row.querySelectorAll('[data-proposal-card] button, [data-proposal-card] form')).toHaveLength(0);
  expect(row.querySelector('a[href="/approvals?tab=leave&id=lr-aminah&from=today"]')).not.toBeNull();
  expect(panel.getAttribute('tabindex')).toBe('-1');
  await new Promise(resolve=>setTimeout(resolve,0));expect(document.activeElement).toBe(panel);
 });
 // Moved from test/review/review-ui-ai-centre-inbox-digest (M10) and review-ui-ai-centre-inbox-payroll-off (M11).
 it('sends nobody to a page they cannot open: no approvals link for an employee with nothing to approve, no payroll link without payroll',async()=>{
  let view=await show(EMPLOYEE,['co-a']);
  expect(view.container.querySelector('a[href^="/approvals"]')).toBeNull();
  cleanup();
  S.modules.delete('payroll');
  view=await show(HR_ADMIN,['co-a']);
  expect(view.container.querySelector('a[href^="/payroll"]')).toBeNull();
 });
});

describe('Today for an HR administrator',()=>{
 beforeEach(()=>{
  S.readiness={employees:10,ready:6};
  S.proposals=[{count:1}];
  S.digest={recordId:'r',preparedAt:new Date('2026-11-03T22:00:00Z'),digest:{asOf:'2026-11-04',setup:{blocked:1,attention:1,companies:1,unknown:0,page:'/control-tower/readiness'},deadlines:null}};
  S.worklist={'co-a':[{status:'due_soon'},{status:'due_soon'},{status:'overdue'},{status:'upcoming'}],'co-b':[{status:'overdue'}]};
  S.exceptions={total:5,rows:[{disposition:'block'},{disposition:'review'},{disposition:'block'},{disposition:'review'},{disposition:'review'}]};
  S.passports=[
   {itemId:'e1',employmentId:'e1',companyId:'co-a',stage:'passport:2026-11-20',waitingOn:'2026-11-20'},
   {itemId:'e2',employmentId:'e2',companyId:'co-a',stage:'passport:2026-11-15',waitingOn:'2026-11-15'},
   {itemId:'e3',employmentId:'e3',companyId:'co-b',stage:'passport:2026-11-05',waitingOn:'2026-11-05'},
  ];
  S.summary={...fx.empty,answeredForYou:1};
 });

 it('lays out Needs you, Done for you and Watching with the findings each owner returned',async()=>{
  const view=await show(HR_ADMIN,['co-a']);
  expect(view.container.querySelector('[data-today="administrator"]')).not.toBeNull();
  expect(text(view.section('today-needs-you')!.querySelector('h2'))).toBe('Needs you');
  expect(text(view.container.querySelector('h1'))).toBe('Good morning, Ravi');
  expect(view.container.querySelectorAll('[data-today-ask] [role="group"]')).toHaveLength(0);
  expect(view.container.querySelector('[data-today-ask] input')?.getAttribute('placeholder')).toBe('Ask AI Centre, or tell it what to do…');
  const needs=view.section('today-needs-you')!;
  expect([...needs.querySelectorAll('[data-today-finding]')].map(card=>[card.getAttribute('data-today-finding'),text(card.querySelector('h3')),card.querySelector('a')?.getAttribute('href')])).toEqual([
   // AI Centre restructure: setup opens the go-live setup with its stages (Today fix c), and prepared fixes open
   // Exceptions' "cause already fixed" group, where the former Proposed actions are approved.
   ['setup','2 setup stages need attention','/payroll/setup?readiness=full'],
   ['readiness','4 employee records are missing required data','/control-tower/readiness'],
   ['proposals','1 prepared fix waits for your approval','/control-tower/exceptions#fixed-causes'],
  ]);
  const watching=view.section('today-watching')!;
  expect([...watching.querySelectorAll('[data-today-note]')].map(note=>[note.getAttribute('data-today-note'),text(note.querySelector('h3')),text(note.querySelector('h3 + p')),note.querySelector('a')?.getAttribute('href')])).toEqual([
   ['deadlines','3 CP22 or CP22A notifications need filing','1 is overdue. Due within 7 days, from the statutory compliance worklist.','/payroll/statutory-forms'],
   ['exceptions','5 payroll exceptions are open','2 block a payroll run.','/control-tower/exceptions'],
  ]);
  // Today fix b: passports are shown once, as the passports loop's own card; the 30-day follow-up list is not read here.
  expect(S.calls.passports).toBe(0);
  expect(view.container.querySelector('[data-today-note="passports"]')).toBeNull();
  expect(view.section('today-at-a-glance')).toBeNull();
  expect(text(view.section('today-done-for-you')!.querySelector('[data-today-note] h3'))).toBe('Answered 1 of your questions');
 });

 it('does not show a setup count from a digest prepared on another day',async()=>{
  S.digest={recordId:'r',preparedAt:new Date('2026-11-02T22:00:00Z'),digest:{asOf:'2026-11-03',setup:{blocked:3,attention:0,companies:1,unknown:0,page:'/control-tower/readiness'},deadlines:null}};
  const view=await show(HR_ADMIN,['co-a']);
  expect(view.container.querySelector('[data-today-finding="setup"]')).toBeNull();
 });

 it('leaves payroll out entirely when the payroll module is off',async()=>{
  S.modules.delete('payroll');
  const view=await show(HR_ADMIN,['co-a']);
  expect(S.calls).toMatchObject({proposals:0,exceptions:0,worklist:[]});
  expect(view.container.querySelector('[data-today-note="deadlines"],[data-today-note="exceptions"],[data-today-finding="proposals"]')).toBeNull();
  expect(view.container.querySelector('[data-today-note="passports"]')).toBeNull();
 });

 // AI v2 Phase 1 slice 3: employees' letter requests waiting for HR, for a viewer holding the letters `generate` capability.
 it('puts waiting letter requests in Needs you, linking to the requests on the generate page, for the scope in view',async()=>{
  S.letterRequests=2;
  const view=await show(HR_ADMIN,['co-a']);
  const card=view.section('today-needs-you')!.querySelector('[data-today-finding="letterRequests"]');
  expect(text(card?.querySelector('h3'))).toBe('2 letter requests wait for you');
  expect(card?.querySelector('a')?.getAttribute('href')).toBe('/letters/generate?requests=all#letter-requests');
  expect(text(card)).toContain('Employee letter requests');
  expect(S.calls.letters).toEqual([['co-a']]);
 });
});

describe('Today for a group administrator, with the company scope switcher',()=>{
 beforeEach(()=>{
  S.tasks=[
   {id:'lr-a',kind:'leave',subjectName:'Fictional Aminah',createdAt:'2026-11-02T02:00:00Z',linkPath:'/approvals?tab=leave&id=lr-a',companyId:'co-a'},
   {id:'lr-b',kind:'leave',subjectName:'Fictional Bala',createdAt:'2026-11-02T03:00:00Z',linkPath:'/approvals?tab=leave&id=lr-b',companyId:'co-b'},
  ];
  S.worklist={'co-a':[{status:'overdue'},{status:'overdue'}],'co-b':[{status:'due_soon'}]};
  S.passports=[
   {itemId:'e1',employmentId:'e1',companyId:'co-a',stage:'passport:2026-11-20',waitingOn:'2026-11-20'},
   {itemId:'e3',employmentId:'e3',companyId:'co-b',stage:'passport:2026-11-25',waitingOn:'2026-11-25'},
  ];
  S.summary={...fx.empty,answeredForOthers:46};
 });

 it('narrowed to one company, shows only that company\'s items and figures',async()=>{
  const view=await show(GROUP_ADMIN,['co-b']);
  expect(S.calls.tasks).toEqual([['co-b']]);
  expect(S.calls.worklist).toEqual(['co-b']);
  expect(S.calls.summary).toEqual([expect.objectContaining({companyIds:['co-b']})]);
  const page=text(view.container);
  expect(page).toContain('Approve leave request · Fictional Bala');
  expect(page).not.toContain('Fictional Aminah');
  expect(text(view.container.querySelector('[data-today-note="deadlines"] h3'))).toBe('1 CP22 or CP22A notification needs filing');
  expect(view.container.querySelector('[data-today-note="passports"]')).toBeNull();
  const answered=view.container.querySelector('[data-today-note="answeredOthers"]')!;
  expect(text(answered.querySelector('h3'))).toBe('Answered 46 employee questions');
  expect(text(answered.querySelector('h3 + p'))).toBe('In the last 7 days, for the companies in your current scope. Questions on sensitive matters go to your HR team and are not counted here.');
 });

 it('across both companies, shows both, still one card per pending task',async()=>{
  const view=await show(GROUP_ADMIN,['co-a','co-b']);
  expect(S.calls.worklist).toEqual(['co-a','co-b']);
  expect([...view.container.querySelectorAll('[data-today-task] h3')].map(text)).toEqual(['Approve leave request · Fictional Aminah','Approve leave request · Fictional Bala']);
  expect(text(view.container.querySelector('[data-today-note="deadlines"] h3'))).toBe('3 CP22 or CP22A notifications need filing');
 });
});

describe('Today for a payroll partner',()=>{
 it('gets the personal layout and no administrator-only finding or watch item',async()=>{
  S.readiness={employees:10,ready:1};S.proposals=[{count:4}];S.exceptions={total:2,rows:[{disposition:'block'},{disposition:'block'}]};
  S.passports=[{itemId:'e1',employmentId:'e1',companyId:'co-a',stage:'passport:2026-11-20',waitingOn:'2026-11-20'}];
  const view=await show(PAYROLL_PARTNER,['co-a']);
  expect(view.container.querySelector('[data-today="personal"]')).not.toBeNull();
  expect(text(view.section('today-needs-you')!.querySelector('h2'))).toBe('Ready for you to confirm');
  expect(S.calls).toMatchObject({proposals:0,readiness:0,exceptions:0,passports:0,worklist:[]});
  expect(view.container.querySelector('[data-today-finding],[data-today-section="today-watching"]')).toBeNull();
  expect(view.section('today-at-a-glance')).not.toBeNull();
 });
});

describe('Today with nothing to show',()=>{
 it('says so once per section and invents no figure',async()=>{
  S.timeOff={version:1,employmentId:'emp-own',asOf:'2026-11-04',canApply:true,balances:[],nextApproved:null};
  S.pay={version:1,employmentId:'emp-own',payslips:[],nextPayment:null};
  let view=await show(EMPLOYEE,['co-a']);
  expect(text(view.section('today-needs-you')!.querySelector('[data-today-empty]'))).toBe('Nothing needs you right now.');
  expect(view.section('today-needs-you')!.querySelector('[data-today-count]')).toBeNull();
  expect(text(view.section('today-done-for-you')!.querySelector('[data-today-empty]'))).toBe('Nothing done for you in the last 7 days yet.');
  const glance=view.section('today-at-a-glance')!;
  expect(text(glance.querySelector('[data-today-payslip="none"]'))).toBe('No payslip released yet.');
  expect(text(glance.querySelector('[data-today-glance="coming-up"] p'))).toBe('Nothing coming up in the next two weeks.');
  cleanup();
  view=await show(HR_ADMIN,['co-a']);
  expect(text(view.section('today-watching')!.querySelector('[data-today-empty]'))).toBe('Nothing to watch right now.');
  expect(text(view.section('today-needs-you')!.querySelector('[data-today-empty]'))).toBe('Nothing needs you right now.');
  expect(view.container.querySelector('[role="status"]')).toBeNull();
 });

 it('a person with no own employment yet gets the At a glance empty state, not an error',async()=>{
  S.timeOffError=new fx.FixtureHomeAccessError('chooseEmployment');S.payError=new fx.FixtureHomeAccessError('chooseEmployment');S.name=null;
  const view=await show(EMPLOYEE,['co-a']);
  expect(text(view.container.querySelector('h1'))).toBe('Good morning, Aisyah');
  const glance=view.section('today-at-a-glance')!;
  expect(text(glance.querySelector('[data-today-empty]'))).toBe('Nothing to show yet.');
  expect(glance.querySelector('[role="status"]')).toBeNull();
 });

 it('a failing owner costs its own section one sentence; the others still render',async()=>{
  S.tasksFail=true;S.summaryFail=true;S.summary={...fx.empty,answeredForYou:9};
  S.timeOff={version:1,employmentId:'emp-own',asOf:'2026-11-04',canApply:true,nextApproved:null,balances:[{id:'lt-al',name:'Annual Leave',annualLeave:true,available:2,pending:0}]};
  const view=await show(EMPLOYEE,['co-a']);
  expect(text(view.section('today-needs-you')!.querySelector('[role="status"]'))).toBe('Some items could not be loaded. Their own pages still work.');
  expect(text(view.section('today-done-for-you')!.querySelector('[role="status"]'))).toBe('Some items could not be loaded. Their own pages still work.');
  expect(text(view.section('today-done-for-you'))).not.toContain('9');
  expect(text(view.section('today-at-a-glance')!.querySelector('[data-today-balance] b'))).toBe('2.00 days');
 });
});

describe('Today when the entitlement snapshot cannot be resolved',()=>{
 it('says its sections could not load, never that the modules are off, and still renders',async()=>{
  S.entitlementsFail=true;
  S.timeOff={version:1,employmentId:'emp-own',asOf:'2026-11-04',canApply:true,nextApproved:null,balances:[{id:'lt-al',name:'Annual Leave',annualLeave:true,available:2,pending:0}]};
  S.pay={version:1,employmentId:'emp-own',nextPayment:null,payslips:[{id:'ps-oct',period:'2026-10',runType:'regular',runSequence:1}]};
  const view=await show(EMPLOYEE,['co-a']);
  const note='Some items could not be loaded. Their own pages still work.';
  expect(text(view.section('today-needs-you')!.querySelector('[role="status"]'))).toBe(note);
  expect(text(view.section('today-at-a-glance')!.querySelector('[role="status"]'))).toBe(note);
  // The leave balance still shows; the payslip row (payroll unread) does not.
  expect(text(view.section('today-at-a-glance')!.querySelector('[data-today-balance] b'))).toBe('2.00 days');
  expect(text(view.section('today-at-a-glance'))).not.toContain('October 2026');
  // The approvals queue is still asked, with every module off for this view.
  expect(S.calls.tasks).toEqual([['co-a']]);
 });
 it('an administrator\'s Watching section says the same and reads no payroll deadlines',async()=>{
  S.entitlementsFail=true;
  const view=await show(HR_ADMIN,['co-a']);
  expect(text(view.section('today-watching')!.querySelector('[role="status"]'))).toBe('Some items could not be loaded. Their own pages still work.');
  expect(S.calls.worklist).toEqual([]);expect(S.calls.exceptions).toBe(0);
 });
});

describe('Today with the cards the loops prepared (AI v2 W8)',()=>{
 const cardsOf=(view:Awaited<ReturnType<typeof show>>)=>[...view.section('today-needs-you')!.querySelectorAll('[data-today-loop]')].map(card=>({
  kind:card.getAttribute('data-today-loop'),title:text(card.querySelector('h3')),meta:[...card.querySelectorAll('h3 + div > span:not([role])')].map(text),
  links:[...card.querySelectorAll('a')].map(link=>[link.getAttribute('href'),text(link)])}));
 it('an employee sees their own cards, each opening the owner\'s own page, and nothing changes from the card',async()=>{
  S.loops=[
   {kind:'clockOut',caseId:'c1',date:'2026-11-03',checkIn:'09:02',proposedCheckOut:'18:00',href:'/attendance/my-records/2026-11-03?checkOut=18%3A00'},
   {kind:'record',caseId:'c2',gaps:['no_bank_account'],href:'/me?tab=bankStatutory#section-request-bankStatutory'},
   {kind:'passport',caseId:'c3',expiresOn:'2026-12-20',href:'/me?tab=profile'},
  ];
  const view=await show(EMPLOYEE,['co-a']);
  expect(S.calls.loops).toEqual([{scopeIds:['co-a'],admin:false}]);
  expect(text(view.section('today-needs-you')!.querySelector('[data-today-count]'))).toBe('3');
  expect(cardsOf(view)).toEqual([
   {kind:'clockOut',title:'Did you leave at 18:00 on Tue, Nov 3?',
    meta:['Clock-in on record 09:02','No clock-out recorded','Your roster ends at 18:00','Prepared by AI Centre: Missed clock-outs','Nothing changes until you send the correction; your approver decides it as usual.'],
    links:[['/attendance/my-records/2026-11-03?checkOut=18%3A00','Edit · Did you leave at 18:00 on Tue, Nov 3?']]},
   {kind:'record',title:'Your record is missing 1 detail',meta:['No bank account','Prepared by AI Centre: Missing employee data','HR approves your update as usual.'],
    links:[['/me?tab=bankStatutory#section-request-bankStatutory','Fill in · Your record is missing 1 detail']]},
   {kind:'passport',title:'Your passport expires on Dec 20, 2026',meta:['Renew it and send HR the new details.','Prepared by AI Centre: Passports expiring'],
    links:[['/me?tab=profile','Update your details · Your passport expires on Dec 20, 2026']]},
  ]);
  // A card is a link to the owner's page; only the missed clock-out card has a button, its Confirm, which waits for the
  // person's own reason. Nothing has been posted.
  expect([...view.section('today-needs-you')!.querySelectorAll('[data-today-loop] button')].map(button=>[button.closest('[data-today-loop]')!.getAttribute('data-today-loop'),text(button),(button as HTMLButtonElement).disabled]))
   .toEqual([['clockOut','Confirm and submit · Did you leave at 18:00 on Tue, Nov 3?',true]]);
  expect(view.section('today-needs-you')!.querySelectorAll('[data-today-loop] form')).toHaveLength(0);
  expect(clockOut.posts).toEqual([]);
  expect(view.container.textContent).not.toMatch(/noveri/i);
 });
 it('the missed clock-out card: the person picks the reason, then Confirm sends it; Other is typed; a refusal shows in place',async()=>{
  const card={kind:'clockOut',caseId:'c1',date:'2026-11-03',checkIn:'09:02',proposedCheckOut:'18:00',href:'/attendance/my-records/2026-11-03?checkOut=18%3A00'};
  S.loops=[card];clockOut.posts.length=0;clockOut.result={kind:'submitted'};
  let view=await show(EMPLOYEE,['co-a']);
  let el=view.container.querySelector('[data-today-loop="clockOut"]') as HTMLElement;
  const fieldset=el.querySelector('[data-clock-out-reasons]')!;
  expect(text(fieldset.querySelector('legend'))).toBe('Why is the clock-out missing?');
  expect([...fieldset.querySelectorAll('label')].map(text)).toEqual(['Forgot to clock out','Device problem','Other']);
  expect([...fieldset.querySelectorAll('input[type="radio"]')].map(input=>(input as HTMLInputElement).checked)).toEqual([false,false,false]);
  const confirmButton=()=>within(el).getByRole('button',{name:'Confirm and submit · Did you leave at 18:00 on Tue, Nov 3?'}) as HTMLButtonElement;
  expect(confirmButton().disabled).toBe(true);
  fireEvent.click(within(el).getByRole('radio',{name:'Forgot to clock out'}));
  expect(confirmButton().disabled).toBe(false);
  fireEvent.click(confirmButton());
  expect(text(await within(el).findByRole('status'))).toBe('Confirmed by you · Sent for approval, not approved yet.');
  expect(clockOut.posts).toEqual([{caseId:'c1',reason:'forgot',confirm:true}]);
  expect(el.querySelector('[data-clock-out-reasons]')).toBeNull();
  cleanup();

  // Other: Confirm waits for the person's own words, which are posted as typed.
  clockOut.posts.length=0;
  view=await show(EMPLOYEE,['co-a']);el=view.container.querySelector('[data-today-loop="clockOut"]') as HTMLElement;
  fireEvent.click(within(el).getByRole('radio',{name:'Other'}));
  const typed=within(el).getByRole('textbox',{name:'Type the reason'}) as HTMLInputElement;
  expect(typed.maxLength).toBe(500);expect(confirmButton().disabled).toBe(true);
  fireEvent.change(typed,{target:{value:'Fictional: the gate reader was off'}});
  clockOut.result={kind:'refused',reason:'changed'};
  fireEvent.click(confirmButton());
  expect(text(await within(el).findByRole('alert'))).toBe('This day has changed since the card was prepared, so nothing was sent. Use Edit to check it on the form.');
  expect(clockOut.posts).toEqual([{caseId:'c1',reason:'other',other:'Fictional: the gate reader was off',confirm:true}]);
  // Edit still opens the correction form, with the proposed clock-out.
  expect(within(el).getByRole('link',{name:'Edit · Did you leave at 18:00 on Tue, Nov 3?'})).toHaveAttribute('href','/attendance/my-records/2026-11-03?checkOut=18%3A00');
 });
 it('an HR administrator sees the review, payroll and passport cards for the companies in scope',async()=>{
  S.loops=[
   {kind:'probation',caseId:'p1',name:'Siti Fictional',endDate:'2026-11-14',stage:'none',overdue:false,reviewId:null,href:'/admin/personnel/emp-siti'},
   {kind:'payroll',caseId:'p2',companyName:'Fictional Sdn Bhd',payPeriod:'2026-11',cutOff:'2026-11-10',missing:['payrollCycle','payrollSchedule'],blockers:1,checks:['claims','statutoryBank'],
    href:'/control-tower/loops/payroll-cycle?company=co-a&period=2026-11'},
   {kind:'passports',count:2,first:'2026-11-20',href:'/personnel'},
  ];
  const view=await show(HR_ADMIN,['co-a']);
  expect(S.calls.loops).toEqual([{scopeIds:['co-a'],admin:true}]);
  expect(cardsOf(view)).toEqual([
   {kind:'probation',title:'Probation ends Nov 14, 2026: Siti Fictional',meta:['No review started yet','Prepared by AI Centre: Probation ending','The loop never decides: HR records the decision.'],
    links:[['/admin/personnel/emp-siti','Review · Probation ends Nov 14, 2026: Siti Fictional']]},
   {kind:'payroll',title:'Fictional Sdn Bhd: payroll inputs missing before the Nov 10, 2026 cut-off',
    meta:['Claims decided, Bank, EPF, SOCSO and tax numbers','Payroll cycle, Payroll schedule','1 blocks the run','Prepared by AI Centre: Pre-salary loop'],
    links:[['/control-tower/loops/payroll-cycle?company=co-a&period=2026-11','Open payroll cycle · Fictional Sdn Bhd: payroll inputs missing before the Nov 10, 2026 cut-off']]},
   {kind:'passports',title:'2 passports expire within 60 days',meta:['First on Nov 20, 2026','Prepared by AI Centre: Passports expiring'],
    links:[['/personnel','Open people · 2 passports expire within 60 days']]},
  ]);
 });
 it('a probation review already waiting as an approvals task shows once, as that task, with the loop\'s context',async()=>{
  const REVIEW='44444444-4444-4444-8444-444444444444',OTHER='55555555-5555-4555-8555-555555555555';
  S.tasks=[{id:REVIEW,kind:'hrReview',subjectName:'Siti Fictional',createdAt:'2026-11-03T02:00:00Z',linkPath:`/approvals?focus=hrReview:${REVIEW}`,companyId:'co-a'}];
  S.loops=[
   {kind:'probation',caseId:'p1',name:'Siti Fictional',endDate:'2026-11-02',stage:'with_hr',overdue:true,reviewId:REVIEW,href:`/approvals?focus=hrReview:${REVIEW}`},
   {kind:'probation',caseId:'p2',name:'Wei Fictional',endDate:'2026-11-16',stage:'with_manager',overdue:false,reviewId:OTHER,href:'/admin/personnel/emp-wei'},
  ];
  const view=await show(HR_ADMIN,['co-a']);
  const needs=view.section('today-needs-you')!;
  // Two items, not three: Siti's review once, as the task, and Wei's card, whose review is not this viewer's task.
  expect(text(needs.querySelector('[data-today-count]'))).toBe('2');
  expect(cardsOf(view).map(card=>[card.kind,card.title])).toEqual([['probation','Probation ends Nov 16, 2026: Wei Fictional']]);
  const task=needs.querySelector('[data-today-task="hrReview"]')!;
  expect(task.getAttribute('data-today-task-loop')).toBe('loop_probation_ending');
  expect(text(task.querySelector('h3'))).toBe('Record HR review decision · Siti Fictional');
  expect([...task.querySelectorAll('h3 + div > span:not([role])')].map(text)).toEqual(['From approvals','Received Nov 3, 2026','A probation ends Nov 2, 2026',
   'The end date has passed with no decision','Prepared by AI Centre: Probation ending']);
 });
 it('a failing loop read costs Needs you one sentence, never a guessed card',async()=>{
  S.loopsFail=true;
  const view=await show(EMPLOYEE,['co-a']);
  expect(text(view.section('today-needs-you')!.querySelector('[role="status"]'))).toBe('Some items could not be loaded. Their own pages still work.');
  expect(view.section('today-needs-you')!.querySelectorAll('[data-today-loop]')).toHaveLength(0);
 });
});

describe('Today at phone width',()=>{
 it('is one column until the large breakpoint, and every control keeps a 44px target on a coarse pointer',async()=>{
  S.tasks=[{id:'notice-1',kind:'noticeAcknowledgement',subjectName:null,createdAt:'2026-11-03T02:00:00Z',linkPath:'/notices/notice-1',companyId:'co-a'}];
  S.timeOff={version:1,employmentId:'emp-own',asOf:'2026-11-04',canApply:true,nextApproved:null,balances:[{id:'lt-al',name:'Annual Leave',annualLeave:true,available:2,pending:0}]};
  for(const [session,grid] of [[EMPLOYEE,'lg:grid-cols-[minmax(0,1fr)_20rem]'],[HR_ADMIN,'lg:grid-cols-3']] as const){
   const view=await show(session,['co-a']);
   const root=view.container.querySelector('[data-today]')!;
   expect(root.className).toContain('min-w-0');
   const columns=root.querySelector('.grid')!;
   // No column count below the large breakpoint: a phone gets one column.
   expect(columns.className.split(/\s+/).filter(name=>/grid-cols/.test(name))).toEqual([grid]);
   for(const control of root.querySelectorAll('a,button,input')){
    const cls=control.getAttribute('class')??'';
    expect(/(^|\s)(min-h-11|size-11|pointer-coarse:min-h-11)(\s|$)/.test(cls),`${control.tagName} ${text(control)}`).toBe(true);
   }
   cleanup();
  }
 });
});

it('Home keeps a 500000-Claim count without reading the entire queue into its five cards',async()=>{
 S.tasks=Array.from({length:25},(_,i)=>({id:'claim-'+i,kind:'claim',subjectName:'Fictional claimant '+i,createdAt:'2026-11-02T02:00:00Z',linkPath:'/approvals?category=claim',companyId:'co-a'}));
 S.claimTotal=500000;
 const view=await show(MANAGER,['co-a']);
 expect(view.container.querySelectorAll('[data-today-task="claim"]')).toHaveLength(5);
 const needs=view.section('today-needs-you')!;
 expect(text(needs.querySelector('[data-today-count]'))).toBe('500000');
 expect(text(needs.querySelector('a[href="/?needs=all"]'))).toContain('500000');
 expect(S.calls.tasks).toEqual([['co-a']]);
});
