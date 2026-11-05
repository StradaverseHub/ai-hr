/** AI v2 Phase 2, P2-3 — the "Before payroll" checklist as each role sees it: Today's card and "My payroll readiness",
 * its own personal page since the AI Centre restructure (owner decision 27: /me/payroll-readiness; Insights is for
 * administrators only), rendered from fictional checklists through the real English catalogue.
 *
 * The checklist read (core/pre-salary/person-items.ts) is replaced by a fixture per role: an employee (their own
 * company's cut-off date, read through app.own_payroll_cut_off_day, migration 0967), a manager with no employment of
 * their own here (no cut-off date: none is guessed) and an administrator (the company's cut-off date). Expected text is written out literally. Pinned: the title carries the cut-off date only
 * when the payroll owner gave one; the top three items, the waiting line and "See all"; one action per row, the
 * missed clock-out's own Confirm card on the personal page (and a pointer to it in Needs you on Today); groups with their
 * status in words; approvals only for whoever has some, and never repeated on Today's card (they are in Needs you, Today
 * fix a); nothing shown when nothing is pending; no pay figure anywhere. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {withAiCentre} from './helpers/ai-centre-messages';
import {resolveServerTree} from './helpers/server-tree';
import type {PayrollItem,PayrollReadiness} from '../lib/pre-salary/items';

const fx=vi.hoisted(()=>({readiness:null as unknown,calls:[] as unknown[]}));
const SESSION_FIXTURE=vi.hoisted(()=>({tenantId:'t',userId:'u',personId:'p',roles:['employee']}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const base=(await import('../messages/en.json')).default;
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const messages=merge('en',base);
 return {getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages,namespace:namespace as never}),getLocale:async()=>'en'};
});
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),refresh:vi.fn()}),usePathname:()=>'/assistant'}));
vi.mock('@/app/assistant/loop-clock-out-actions',()=>({confirmMissedClockOutAction:async()=>({kind:'submitted'})}));
vi.mock('@/app/assistant/payroll-readiness-actions',()=>({answerTp3PreviousEmployerAction:vi.fn()}));
vi.mock('@/core/pre-salary/person-items',()=>({readMyPayrollReadiness:async(...args:unknown[])=>{fx.calls.push(args.slice(1));return fx.readiness;}}));
// The personal page's guard: a signed-in person and their company scope (lib/scope.ts), stood in for here.
vi.mock('@/lib/scope',()=>({scopedSession:async()=>({s:SESSION_FIXTURE,scopeIds:['co-1']})}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
// Insights' accuracy figures have their own test (ai-quality-page.dom.test.tsx); a marker here.
vi.mock('@/components/ai-centre/check-accuracy',()=>({CheckAccuracySection:()=><section data-check-accuracy-marker/>}));
// Wave 1 integration: Insights also carries P2-4's HR capacity ledger, for administrators only (its own test:
// capacity-ledger-page.dom.test.tsx). Here it is a marker, so each role shows whether the view asked for it.
vi.mock('@/components/ai-centre/capacity-ledger',()=>({CapacityLedgerSection:()=><section data-capacity-ledger-marker/>}));
// Wave 2: and P2-6's AI quality, for administrators only (its own test: ai-quality-page.dom.test.tsx); a marker here too.
vi.mock('@/components/ai-centre/ai-quality',()=>({AiQualitySection:()=><section data-ai-quality-marker/>}));

import {BeforePayrollSection} from '../components/today/before-payroll';
import {AiCentreInsights} from '../components/ai-centre/insights';
import MyPayrollReadinessPage from '../app/me/payroll-readiness/page';
import {AiCentreTabs} from '../components/ai-centre/centre-tabs';

const SESSION={tenantId:'t',userId:'u',personId:'p',roles:['employee']} as never;
const open=(href:string)=>({kind:'open' as const,href});
const item=(kind:PayrollItem['kind'],group:PayrollItem['group'],state:PayrollItem['state'],date:string|null,due:string|null,action:PayrollItem['action'],extra:Partial<PayrollItem>={}):PayrollItem=>
 ({key:`${kind}:${date}`,kind,group,state,date,due,action,...extra});
const groups=(status:Partial<Record<PayrollItem['group'],string>>)=>(['attendance','overtime','leave','claims','toil','details','acknowledge','approvals'] as const)
 .map(group=>({group,status:(status[group]??'done') as never}));

const EMPLOYEE:PayrollReadiness={period:{payPeriod:'2026-11',start:'2026-10-20',cutOff:'2026-11-19',source:'company'},failed:false,
 items:[
  item('missed_clock_out','attendance','todo','2026-11-03',null,{kind:'confirm',card:'clockOut',caseId:'case-1',date:'2026-11-03',checkIn:'09:02',proposedCheckOut:'18:00',href:'/attendance/my-records/2026-11-03?checkOut=18%3A00'}),
  item('claim_receipt_missing','claims','todo','2026-11-08','2026-11-15',open('/claims?draft=cl-1'),{label:'Parking'}),
  item('bank_missing','details','todo',null,null,open('/me?tab=bankStatutory#section-request-bankStatutory')),
  item('late_or_early','attendance','check','2026-11-06',null,open('/attendance/requests?section=short&fix=2026-11-06')),
  item('leave_pending','leave','waiting','2026-11-12',null,open('/leave'),{label:'Annual Leave',endDate:'2026-11-13'})],
 approvals:[],groups:groups({attendance:'todo',claims:'todo',details:'todo',leave:'waiting',toil:'off'})};
const MANAGER:PayrollReadiness={period:{payPeriod:'2026-11',start:'2026-11-01',cutOff:null,source:'unavailable'},failed:false,items:[],
 approvals:[item('approve_leave','approvals','todo',null,null,open('/approvals?section=leave&focus=t-1'),{key:'approve_leave:t-1',label:'Siti Fictional'}),
  item('approve_claim','approvals','todo',null,null,open('/approvals?section=claims&focus=t-2'),{key:'approve_claim:t-2',label:'Wei Fictional'})],
 groups:groups({approvals:'todo'})};
const ADMIN:PayrollReadiness={period:{payPeriod:'2026-11',start:'2026-10-20',cutOff:'2026-11-19',source:'company'},failed:false,
 items:[item('tax_number_missing','details','todo',null,'2026-11-19',open('/me?tab=bankStatutory#section-request-bankStatutory'))],
 approvals:[item('approve_attendance','approvals','todo',null,'2026-11-19',open('/approvals?section=attendance&focus=t-3'),{key:'approve_attendance:t-3',label:'Nur Fictional'})],
 groups:groups({details:'todo',approvals:'todo'})};
const NOTHING:PayrollReadiness={...ADMIN,items:[],approvals:[],groups:groups({})};

const messages=withAiCentre('en',en) as never;
const show=async(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">{await resolveServerTree(node)}</NextIntlClientProvider>);
const today=(readiness:unknown)=>{fx.readiness=readiness;return show(<BeforePayrollSection session={SESSION} employmentId="emp-own" scopeIds={['co-1']} locale="en" today="2026-11-10"/>);};
const page=async(readiness:unknown)=>{fx.readiness=readiness;return show(await MyPayrollReadinessPage());};
const rows=(root:HTMLElement)=>[...root.querySelectorAll('[data-payroll-item]')].map(row=>[row.getAttribute('data-payroll-item'),row.querySelector('p')?.textContent,
 row.querySelector('a')?.textContent?.split(' · ')[0],row.querySelector('a')?.getAttribute('href')]);
beforeEach(()=>{fx.calls=[];});
afterEach(cleanup);

describe('Today: "Before payroll on <date>"',()=>{
 it('employee: their own company\'s cut-off date, the top three items, the waiting line and See all',async()=>{
  const view=await today(EMPLOYEE);
  const card=view.container.querySelector('[data-today-section="today-before-payroll"]') as HTMLElement;
  expect(within(card).getByRole('heading',{level:2}).textContent).toBe('Before payroll on Nov 19');
  expect(card.querySelector('[data-today-count]')?.textContent).toBe('4');
  expect(rows(card)).toEqual([
   ['missed_clock_out','Missing clock-out · Nov 3','Confirm','#today-needs-you'],
   ['claim_receipt_missing','Add the receipt to your Parking claim · Nov 8','Open','/claims?draft=cl-1'],
   ['bank_missing','Add your bank account','Open','/me?tab=bankStatutory#section-request-bankStatutory']]);
  expect(card.querySelector('[data-payroll-item="claim_receipt_missing"]')?.textContent).toContain('Due Nov 15');
  expect(card.querySelector('[data-payroll-waiting]')?.textContent).toBe('1 item is waiting for someone else to approve.');
  // "See all" opens the person's own page (owner decision 27).
  expect(within(card).getByRole('link',{name:'See all'})).toHaveAttribute('href','/me/payroll-readiness');
  expect(card.textContent).not.toMatch(/RM|\d+\.\d{2}/);
  expect(fx.calls).toEqual([[{employmentId:'emp-own',scopeIds:['co-1'],locale:'en',today:'2026-11-10',approvalPreview:true}]]);
 });
 it('manager whose only items are decisions waiting on them: no card, because Needs you already lists those decisions',async()=>{
  const view=await today(MANAGER);
  expect(view.container.querySelector('[data-today-section="today-before-payroll"]')).toBeNull();
  expect(view.container.querySelector('[data-payroll-item^="approve_"]')).toBeNull();
 });
 it('administrator: the company\'s cut-off date from the payroll owner in the title, and their own items only',async()=>{
  const card=(await today(ADMIN)).container.querySelector('[data-today-section="today-before-payroll"]') as HTMLElement;
  expect(within(card).getByRole('heading',{level:2}).textContent).toBe('Before payroll on Nov 19');
  // The approval waiting on them is in Needs you; the card does not repeat it (Today fix a).
  expect(rows(card).map(row=>row[0])).toEqual(['tax_number_missing']);
  expect(card.querySelector('[data-today-count]')?.textContent).toBe('1');
 });
 it('a new joiner: the TP3 item asks its one-tap question on the card, Yes and No posting the person\'s own employment and year',async()=>{
  const question=item('tp3_new_joiner','details','check','2026-03-02','2026-11-19',{kind:'answer',card:'tp3PreviousEmployer',employmentId:'emp-own',year:2026,href:'/me/tp3'});
  const card=(await today({...NOTHING,items:[question],groups:groups({details:'todo'})})).container.querySelector('[data-today-section="today-before-payroll"]') as HTMLElement;
  const row=card.querySelector('[data-payroll-item="tp3_new_joiner"]') as HTMLElement;
  expect(row.getAttribute('data-payroll-action')).toBe('answer');
  expect(row.querySelector('p')?.textContent).toBe('Did you work for another employer earlier this year?');
  const form=within(row).getByRole('form',{name:'Did you work for another employer earlier this year?'});
  expect([...form.querySelectorAll('input[type="hidden"]')].map(input=>[input.getAttribute('name'),input.getAttribute('value')])).toEqual([['employment','emp-own'],['year','2026']]);
  expect([...form.querySelectorAll('button[type="submit"]')].map(button=>[button.getAttribute('name'),button.getAttribute('value'),button.textContent?.split(' · ')[0]]))
   .toEqual([['answer','no','No'],['answer','yes','Yes']]);
  // No link stands in for the answer; the row carries no amount.
  expect(row.querySelector('a')).toBeNull();
  expect(row.textContent).not.toMatch(/RM|\d+\.\d{2}/);
 });
 it('shows no card when nothing is pending, payroll is not in use, or the read failed',async()=>{
  for(const readiness of [NOTHING,null]){
   const view=await today(readiness);
   expect(view.container.querySelector('[data-today-section="today-before-payroll"]')).toBeNull();
   cleanup();
  }
 });
});

describe('My payroll readiness, the person\'s own page (/me/payroll-readiness)',()=>{
 it('employee: every item by group with the status in words, the clock-out Confirm card in its group, no approvals',async()=>{
  const view=await page(EMPLOYEE);
  expect(fx.calls).toEqual([[{scopeIds:['co-1'],locale:'en'}]]);
  const section=view.container.querySelector('#my-payroll-readiness') as HTMLElement;
  // The page's own title, with the way back to Today.
  expect(within(section).getByRole('heading',{level:1}).textContent).toBe('My payroll readiness');
  expect(view.getByRole('link',{name:'Back to Today'})).toHaveAttribute('href','/');
  expect(section.querySelector('[data-payroll-cutoff]')?.textContent).toBe('November 2026 payroll · cut-off Nov 19');
  const status=[...section.querySelectorAll('[data-payroll-group]')].map(group=>[group.getAttribute('data-payroll-group'),group.querySelector('h3')?.textContent,
   group.querySelector('h3')?.nextElementSibling?.textContent]);
  // Replacement leave is not in use for this person: not shown. No approvals wait on an employee.
  expect(status).toEqual([['attendance','Attendance','To do'],['overtime','Overtime','Done'],['leave','Leave','Waiting'],['claims','Claims','To do'],
   ['details','Personal and statutory details','To do'],['acknowledge','To acknowledge','Done']]);
  const attendance=section.querySelector('[data-payroll-group="attendance"]') as HTMLElement;
  expect(rows(attendance)).toEqual([['late_or_early','Late arrival or early finish · Nov 6','Open','/attendance/requests?section=short&fix=2026-11-06']]);
  // The missed clock-out is the loop's own card, with its own Confirm and Edit.
  const clockOut=attendance.querySelector('[data-today-loop="clockOut"]') as HTMLElement;
  expect(clockOut).toBeTruthy();
  expect(within(clockOut).getByRole('button',{name:/Confirm and submit/})).toBeTruthy();
  expect(within(clockOut).getByRole('link',{name:/Edit/})).toHaveAttribute('href','/attendance/my-records/2026-11-03?checkOut=18%3A00');
  expect(rows(section.querySelector('[data-payroll-group="leave"]') as HTMLElement)).toEqual([['leave_pending','Annual Leave waiting for approval · Nov 12 to Nov 13','Open','/leave']]);
  expect((section.querySelector('[data-payroll-group="overtime"]') as HTMLElement).textContent).toContain('Nothing pending.');
  expect(section.querySelector('#payroll-approvals-heading')).toBeNull();
  expect(section.textContent).toContain('Not checked here yet: shift swaps, roster gaps, timesheet sign-off, overtime worked but not yet applied for, and pay changes to acknowledge.');
  expect(section.textContent).not.toMatch(/RM|\d+\.\d{2}/);
  // A personal page: no AI Centre tab bar, no administrator section.
  expect(view.container.querySelector('[data-ai-centre-tabs],[data-capacity-ledger-marker],[data-ai-quality-marker]')).toBeNull();
 });
 it('manager: the decisions waiting on them under "Waiting on you", each a link to its approval',async()=>{
  const section=(await page(MANAGER)).container.querySelector('#my-payroll-readiness') as HTMLElement;
  const approvals=section.querySelector('[data-payroll-group="approvals"]') as HTMLElement;
  expect(within(approvals).getByRole('heading',{level:3}).textContent).toBe('Waiting on you');
  expect(rows(approvals)).toEqual([
   ['approve_leave','Leave to approve · Siti Fictional','Review','/approvals?section=leave&focus=t-1'],
   ['approve_claim','Claim to approve · Wei Fictional','Review','/approvals?section=claims&focus=t-2']]);
  expect(section.querySelector('[data-payroll-all-done]')?.textContent).toBe('Nothing is waiting on you for this payroll.');
  expect(section.querySelector('[data-payroll-cutoff]')?.textContent).toBe('November 2026 payroll · your HR team can tell you the cut-off date');
 });
 it('administrator: their own items with the company\'s cut-off date, and their approvals',async()=>{
  const section=(await page(ADMIN)).container.querySelector('#my-payroll-readiness') as HTMLElement;
  expect(section.querySelector('[data-payroll-cutoff]')?.textContent).toBe('November 2026 payroll · cut-off Nov 19');
  expect(section.querySelector('[data-payroll-item="tax_number_missing"]')?.textContent).toContain('Due Nov 19');
  expect(rows(section.querySelector('[data-payroll-group="approvals"]') as HTMLElement).map(row=>row[1])).toEqual(['Attendance or overtime to approve · Nur Fictional']);
 });
 it('says plainly when payroll is not in use, and when the read failed',async()=>{
  const section=(await page(null)).container.querySelector('#my-payroll-readiness') as HTMLElement;
  expect(within(section).getByRole('heading',{level:1}).textContent).toBe('My payroll readiness');
  expect(section.textContent).toContain('Payroll is not in use here, so there is nothing to get ready.');
 });
});

describe('AI Centre › Insights is for administrators only (owner decision 27)',()=>{
 it('renders nothing for anyone else, so none of its reads run',async()=>{
  fx.readiness=EMPLOYEE;
  const view=await show(<AiCentreInsights session={SESSION} isAdmin={false} payroll/>);
  expect(view.container.innerHTML).toBe('');
  expect(fx.calls).toEqual([]);
 });
 it('administrator: HR capacity, then AI quality with its accuracy figures; no personal readiness here',async()=>{
  const view=await show(<AiCentreInsights session={SESSION} isAdmin payroll/>);
  expect(view.getByRole('heading',{level:1,name:'Insights'})).toBeTruthy();
  const ledger=view.container.querySelectorAll('[data-capacity-ledger-marker]'),quality=view.container.querySelectorAll('[data-ai-quality-marker]');
  expect(ledger).toHaveLength(1);expect(quality).toHaveLength(1);
  expect(ledger[0]!.compareDocumentPosition(quality[0]!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(view.container.querySelector('#my-payroll-readiness')).toBeNull();
  expect(fx.calls).toEqual([]);
 });
 it('is a tab for administrators only, current on its own page',async()=>{
  const view=render(<NextIntlClientProvider locale="en" messages={messages}><AiCentreTabs active="insights" isAdmin/></NextIntlClientProvider>);
  expect(view.getByRole('link',{current:'page'})).toHaveAttribute('href','/assistant?view=insights');
  expect(view.getByRole('link',{current:'page'}).textContent).toBe('Insights');
  cleanup();
  const employee=render(<NextIntlClientProvider locale="en" messages={messages}><AiCentreTabs active={null} isAdmin={false}/></NextIntlClientProvider>);
  expect(employee.container.querySelector('a[href="/assistant?view=insights"]')).toBeNull();
 });
});

it('Insights shows a bounded Claim approval preview with its exact count and paginated owner link',async()=>{
 const claim=MANAGER.approvals.find(row=>row.kind==='approve_claim')!;
 const result={...MANAGER,approvalTotal:500000,approvalClaimTotal:500000,approvals:Array.from({length:25},(_,i)=>({...claim,key:'approve_claim:'+i}))};
 const view=await insights(result);
 expect(fx.calls).toEqual([[{scopeIds:['co-1'],locale:'en',approvalPreview:true}]]);
 const section=view.container.querySelector('[data-payroll-group="approvals"]') as HTMLElement;
 expect(section.querySelectorAll('[data-payroll-item="approve_claim"]')).toHaveLength(25);
 expect(section.textContent).toContain('Showing the first 25 of 500,000 rows.');
 expect(section.querySelector('a[href="/approvals?category=claim"]')).not.toBeNull();
});
it('Today counts the whole approval queue while displaying only its short preview',async()=>{
 const result={...MANAGER,approvalTotal:500000,approvalClaimTotal:500000};
 const view=await today(result);
 expect(view.container.querySelector('[data-today-count]')?.textContent).toBe('500000');
 expect(view.container.querySelectorAll('[data-payroll-item]')).toHaveLength(2);
});
