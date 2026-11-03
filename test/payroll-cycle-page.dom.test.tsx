/** @vitest-environment jsdom */
/** AI v2 P2-2a — AI Centre › Operations › Loops › Payroll cycle, the Salary payroll loop's page and the settings page,
 * rendered per role from fictional reads (core/loops/payroll-cycle-views.ts is replaced by a fixture; the real services
 * are covered by test/payroll-cycle-loops.test.ts).
 *
 * The guard is the existing requireAdmin: an employee or a manager is sent away before any read. An HR administrator of
 * one company sees that company with no company filter; a group administrator sees the group pipeline and filters it.
 * Expected text is written out from the fixture through the real catalogues (the approved mock-up's own words where the
 * fixture matches it); every locale renders with no missing message, says AI Centre and never Noveri, and every control
 * keeps a 44px target on a coarse pointer. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import type {ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {withAiCentre} from './helpers/ai-centre-messages';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi_ from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';

type Locale='en'|'ms'|'zh'|'vi'|'ta'|'th';
const CATALOGUES={en,ms,zh,vi:vi_,ta,th};
const messagesFor=(locale:Locale)=>withAiCentre(locale,CATALOGUES[locale] as Record<string,unknown>) as typeof en & {aiCentre:Record<string,any>};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'ta'|'th',session:null as unknown,reads:[] as string[],scope:'group' as 'group'|'company'}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator:translator,createFormatter:formatter}=await import('next-intl');
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const all={en:(await import('../messages/en.json')).default,ms:(await import('../messages/ms.json')).default,zh:(await import('../messages/zh.json')).default,
  vi:(await import('../messages/vi.json')).default,ta:(await import('../messages/ta.json')).default,th:(await import('../messages/th.json')).default};
 return {getTranslations:async(namespace:any)=>translator({locale:state.locale,messages:merge(state.locale,all[state.locale] as any) as any,namespace,onError:error=>{throw error;}}),
  getFormatter:async()=>formatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'})};
});
vi.mock('next/navigation',()=>({
 redirect:vi.fn((url:string)=>{throw Object.assign(Error('NEXT_REDIRECT'),{url});}),
 notFound:vi.fn(()=>{throw Object.assign(Error('NEXT_NOT_FOUND'),{notFound:true});}),
 usePathname:()=>'/control-tower/loops/payroll-cycle',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),
}));
vi.mock('../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>true,isModuleEnabledOrFalse:()=>true}));
vi.mock('../app/control-tower/loops/payroll-cycle/actions',()=>({recordSwingDispositionAction:vi.fn(),setPayrollLoopSettingAction:vi.fn(),decideThresholdProposalAction:vi.fn()}));
const fx=vi.hoisted(()=>{
 const A='00000000-0000-4000-8000-0000000000c1',B='00000000-0000-4000-8000-0000000000c2';
 const check=(key:string,status:string,open=0,waiting=0,warnings=0,info=0)=>({key,status,open,waiting,warnings,info});
 const done=(key:string)=>check(key,'done');
 const companyA={companyId:A,companyName:'Fictional A Sdn Bhd',payDay:'2026-11-28',
  preSalary:{state:'open',payPeriod:'2026-11',cutOff:'2026-11-20',from:'2026-11-01',daysToCutOff:6,lastCheckedAt:new Date('2026-11-14T01:00:00Z'),interval:'hourly',
   checks:[check('timesheets','open',3),check('overtime','waiting',0,14),check('leave','done',0,0,0,2),check('claims','waiting',0,9),check('joinersLeavers','open',2,0,0,2),
    done('statutoryBank'),check('payChanges','done',0,0,0,1),check('setup','warning',0,0,1)]},
  salary:{state:'before_cut_off',cutOff:'2026-11-20',runs:[]}};
 const companyB={companyId:B,companyName:'Fictional B Sdn Bhd',payDay:'2026-11-30',
  preSalary:{state:'done',payPeriod:'2026-11',cutOff:'2026-11-20',from:'2026-11-01',daysToCutOff:6,lastCheckedAt:new Date('2026-11-14T01:00:00Z'),interval:'daily',
   checks:['timesheets','overtime','leave','claims','joinersLeavers','statutoryBank','payChanges','setup'].map(done)},
  salary:{state:'before_cut_off',cutOff:'2026-11-20',runs:[]}};
 const history=[{period:'2026-10',inputsReady:1,issuesCaught:9,closedOn:'2026-10-26',allClosed:true,correctionsAfter:0,runs:2},
  {period:'2026-09',inputsReady:0,issuesCaught:6,closedOn:'2026-09-27',allClosed:true,correctionsAfter:1,runs:2},
  {period:'2026-08',inputsReady:null,issuesCaught:null,closedOn:'2026-08-28',allClosed:true,correctionsAfter:5,runs:1}];
 const people=[{id:'loop_probation_ending',open:3},{id:'loop_missing_employee_data',open:12},{id:'loop_document_expiry',open:4}];
 const overview=(scope:'group'|'company',filter:string|null)=>{
  const allowed=scope==='group'?[{companyId:A,companyName:companyA.companyName},{companyId:B,companyName:companyB.companyName}]:[{companyId:A,companyName:companyA.companyName}];
  const companies=scope==='group'&&!filter?[companyA,companyB]:[companyA];
  return {period:'2026-11',today:'2026-11-14',allowed,filter,companies,loops:{preSalary:{on:true,stopped:false},salary:{on:true,stopped:false}},history,people,audit:null,statutoryDue:'2026-12-15'};
 };
 const run=(over:Record<string,unknown>)=>({caseId:'k-'+String(over.runSeq),batchId:'b-'+String(over.runSeq),companyId:A,payPeriod:'2026-10',runType:'regular',runSeq:1,status:'processed',stale:false,
  employees:42,detectors:11,evaluated:true,exceptions:0,changed:0,flagged:0,thresholdBp:1500,causes:[],ruleVersion:'2026.1',rulesNewer:[],bank:'match',done:false,reopened:0,closedBy:null,
  checkedAt:new Date('2026-11-01T01:00:00Z'),...over});
 const salary={period:'2026-10',today:'2026-11-14',allowed:[{companyId:A,companyName:companyA.companyName}],filter:null,loop:{on:true,stopped:false},
  companies:[{companyId:A,companyName:companyA.companyName,cutOff:'2026-10-20',thresholdBp:1500,startOpen:false,runs:[
   run({runSeq:1,exceptions:2,changed:12,flagged:2,causes:[{kind:'salary_change',count:3},{kind:'overtime_hours',count:8}],rulesNewer:['pcb'],bank:'total_mismatch'}),
   run({runSeq:2,runType:'bonus',status:'closed',employees:5,done:true,closedBy:'Aisyah Fictional',reopened:1})]}],
  flags:[
   {caseId:'00000000-0000-4000-8000-00000000f001',companyId:A,companyName:companyA.companyName,personName:'Ravi Fictional',payPeriod:'2026-10',swingBp:3108,direction:'up',
    pattern:'cause:salary_change',thresholdBp:1500,causes:['salary_change'],state:'open',closeReason:null,disposition:null},
   {caseId:'00000000-0000-4000-8000-00000000f002',companyId:A,companyName:companyA.companyName,personName:'Mei Ling Fictional',payPeriod:'2026-10',swingBp:2328,direction:'down',
    pattern:'item:0000aaaa-0000-4000-8000-00000000a040',thresholdBp:1500,causes:[],state:'closed',closeReason:'done',disposition:{value:'expected',by:'Siti Fictional',at:new Date('2026-11-02T01:00:00Z')}}],
  // Patterns are keyed on the pay component's id; the page shows the catalogue's current name.
  patternNames:{'item:0000aaaa-0000-4000-8000-00000000a040':'Meal Allowance'}};
 const settings={companies:[{companyId:A,companyName:companyA.companyName,
  setting:{companyId:A,version:2,interval:'hourly',thresholdBp:1500,exclusions:['item:0000aaaa-0000-4000-8000-00000000c044','item:0000aaaa-0000-4000-8000-0000000000ff'],source:'proposal',changedByUserId:'u-1',changedAt:new Date('2026-11-03T15:04:00Z')},
  proposals:[{key:'a'.repeat(64),kind:'threshold',fromThresholdBp:1500,toThresholdBp:2000,pattern:null,
   evidence:{windowDays:30,flags:6,expected:5,problems:1,expectedShareBp:8333,smallestProblemBp:2100}}],
  history:[{version:2,interval:'hourly',thresholdBp:1500,exclusions:['item:0000aaaa-0000-4000-8000-00000000c044'],source:'proposal',by:'Aisyah Fictional',at:new Date('2026-11-03T15:04:00Z')},
   {version:1,interval:'hourly',thresholdBp:1500,exclusions:[],source:'admin',by:'Aisyah Fictional',at:new Date('2026-11-02T15:04:00Z')}],
  decisions:[{id:'d-1',kind:'threshold',fromThresholdBp:1500,toThresholdBp:1800,pattern:null,decision:'rejected',by:'Daniel Fictional',at:new Date('2026-11-01T15:04:00Z')}]}],
  // A pattern whose component is no longer in the catalogue has no name.
  patternNames:{'item:0000aaaa-0000-4000-8000-00000000c044':'Sales Commission'}};
 class PayrollCycleRefused extends Error{constructor(readonly reason:string){super(reason);}}
 return {A,B,overview,salary,settings,PayrollCycleRefused};
});
vi.mock('../core/loops/payroll-cycle-views',()=>({PayrollCycleRefused:fx.PayrollCycleRefused,
 payrollCycleOverview:async(_s:unknown,options:{companyId?:string})=>{state.reads.push('overview');return fx.overview(state.scope,typeof options.companyId==='string'?options.companyId:null);},
 salaryLoopPage:async()=>{state.reads.push('salary');return fx.salary;},
 payrollLoopSettingsPage:async()=>{state.reads.push('settings');return fx.settings;}}));
import PayrollCyclePage from '../app/control-tower/loops/payroll-cycle/page';
import SalaryLoopPage from '../app/control-tower/loops/payroll-cycle/salary/page';
import PayrollLoopSettingsPage from '../app/control-tower/loops/payroll-cycle/settings/page';

const TENANT='00000000-0000-4000-8000-0000000000a1';
const SESSIONS={
 employee:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000001',roles:['employee'],grants:[{role:'employee',companyId:fx.A}]},
 manager:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000002',roles:['employee','manager'],grants:[{role:'manager',companyId:fx.A}]},
 hrAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000003',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:fx.A}]},
 groupAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000004',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
} as const;
const wrap=(locale:Locale,node:ReactNode)=>render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} onError={error=>{throw error;}} timeZone="Asia/Kuala_Lumpur">
 <main className="relative min-w-0"><div className="min-w-0">{node}</div></main></NextIntlClientProvider>);
const text=(el:Node|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const parts=(el:Element)=>[...el.childNodes].map(node=>text(node)).filter(Boolean).join(' ');
const cycle=async(query:Record<string,string>={})=>PayrollCyclePage({searchParams:Promise.resolve(query)});
const salary=async(query:Record<string,string>={})=>SalaryLoopPage({searchParams:Promise.resolve(query)});
const settings=async(query:Record<string,string>={})=>PayrollLoopSettingsPage({searchParams:Promise.resolve(query)});
const rows=(container:Element,selector:string)=>[...container.querySelectorAll(`${selector} tbody tr`)].map(row=>[...row.querySelectorAll('th,td')].map(parts));
const coarse=(container:Element)=>{for(const el of container.querySelectorAll('main button, main select, main input:not([type=hidden]), [data-payroll-loops] a, [data-people-loops] a, [data-swing-flags] button'))
 expect(el.className,el.outerHTML.slice(0,120)).toContain('pointer-coarse:min-h-11');};
afterEach(()=>{cleanup();state.locale='en';state.session=null;state.reads=[];state.scope='group';});

describe('Operations › Loops › Payroll cycle, per role',()=>{
 it.each(['employee','manager'] as const)('%s is refused before any read',async role=>{
  state.session=SESSIONS[role];
  await expect(cycle()).rejects.toMatchObject({url:'/'});
  await expect(salary()).rejects.toMatchObject({url:'/'});
  await expect(settings()).rejects.toMatchObject({url:'/'});
  expect(state.reads).toEqual([]);
 });

 it('a group administrator sees the three loops in order, a status per company, the last three cycles and the people loops',async()=>{
  state.session=SESSIONS.groupAdmin;
  const view=wrap('en',await cycle());
  expect(state.reads).toEqual(['overview']);
  expect(within(screen.getByRole('navigation',{name:'Operations sections'})).getByRole('link',{current:'page'})).toHaveAttribute('href','/control-tower/loops');
  expect(screen.getByRole('heading',{level:1,name:'Payroll cycle: November 2026'})).toBeTruthy();
  expect(text(view.container.querySelector('[data-page-header]'))).toContain('Three loops carry each company\'s payroll from inputs to audit. EPF, SOCSO, EIS and PCB due Dec 15. Each company keeps its own cut-off and pay day.');
  const filter=view.container.querySelector('[data-company-filter]')!;
  expect([...filter.querySelectorAll('option')].map(text)).toEqual(['All 2 companies','Fictional A Sdn Bhd','Fictional B Sdn Bhd']);
  const loops=screen.getByRole('list',{name:'Payroll loops in order'});
  const cards=[...loops.querySelectorAll(':scope > li')];
  expect(cards.map(card=>card.getAttribute('data-loop-card'))).toEqual(['pre-salary','salary','audit']);
  const [pre,pay,audit]=cards;
  expect(text(pre.querySelector('h2'))).toBe('1 · Pre-salary loop');
  expect(text(pre.querySelector('[data-loop-state]'))).toBe('Running · 6 days to cut-off');
  expect([...pre.querySelectorAll('[data-loop-checks] li')].map(parts)).toEqual([
   'Timesheets clean 3 open','Overtime approved 14 waiting','Leave and unpaid days final Done','Claims decided 9 waiting','Joiners and leavers complete 2 open',
   'Bank, EPF, SOCSO and tax numbers Done','Allowance and pay changes approved Done','Payroll set-up ready 1 to review']);
  // Each check opens its owner's page.
  expect([...pre.querySelectorAll('[data-loop-checks] a')].map(a=>a.getAttribute('href'))).toEqual(['/attendance/individual','/approvals?category=overtime',
   '/approvals?category=leave','/approvals?category=claim','/personnel','/control-tower/readiness','/performance','/payroll/setup?readiness=full']);
  expect(within(pre as HTMLElement).getByRole('link',{name:'Open Pre-salary loop'})).toHaveAttribute('href','/control-tower/loops/loop_payroll_inputs');
  // Before the cut-off the Salary payroll loop reads as the mock-up does: nothing has run, and a person always closes.
  expect(text(pay.querySelector('h2'))).toBe('2 · Salary payroll loop');
  expect(text(pay.querySelector('[data-loop-state]'))).toBe('Starts at cut-off');
  expect([...pay.querySelectorAll('[data-loop-checks] li')].map(parts)).toEqual(['Run each company\'s payroll Prepared for HR','Change vs last month, per person Explained by cause',
   '11 anomaly checks Exceptions to Today','EPF, SOCSO, EIS, PCB on current rules Rule version shown','Approve and close A person, always','Bank file total equals net pay Checked before release']);
  expect(text(pay)).toContain('This loop stays at Prepare in every company: it checks and prepares, and a person approves and closes.');
  expect(within(pay as HTMLElement).getByRole('link',{name:'Open Salary payroll loop'})).toHaveAttribute('href','/control-tower/loops/payroll-cycle/salary?period=2026-11');
  // The Audit loop's slot: what it is for, and no status until its read exists.
  expect(audit.getAttribute('data-audit-status')).toBe('none');
  expect(audit.querySelector('[data-loop-state]')).toBeNull();
  expect(parts(audit)).toBe('3 · Audit loop Done when everything is paid, filed, reconciled and evidenced. Files and filings stay at Prepare: a person submits to EPF, PERKESO and LHDN.');
  expect(rows(view.container,'[data-payroll-companies]')).toEqual([
   ['Fictional A Sdn Bhd','Running · 6 days to cut-off Timesheets clean, Overtime approved, Claims decided, Joiners and leavers complete Checked hourly','Starts at cut-off','—'],
   ['Fictional B Sdn Bhd','Done Checked daily','Starts at cut-off','—']]);
  expect(view.container.querySelector('[data-payroll-companies] a')).toHaveAttribute('href',`/control-tower/loops/payroll-cycle?period=2026-11&company=${fx.A}`);
  expect(rows(view.container,'[data-payroll-history]')).toEqual([
   ['October 2026','1 day before cut-off','9','Oct 26','0','—'],['September 2026','On cut-off day','6','Sep 27','1','—'],['August 2026','Not measured','Not measured','Aug 28','5','—']]);
  expect([...view.container.querySelectorAll('[data-people-loops] a')].map(a=>[text(a),a.getAttribute('href')])).toEqual([
   ['Probation ending · 3 open','/control-tower/loops/loop_probation_ending'],['Missing employee data · 12 open','/control-tower/loops/loop_missing_employee_data'],
   ['Passports expiring · 4 open','/control-tower/loops/loop_document_expiry']]);
  coarse(view.container);
 });

 it('filtered to one company, the header carries its cut-off, pay day and statutory due date',async()=>{
  state.session=SESSIONS.groupAdmin;
  const view=wrap('en',await cycle({company:fx.A}));
  expect(text(view.container.querySelector('[data-page-header]'))).toContain('Cut-off Nov 20 · pay day Nov 28 · EPF, SOCSO, EIS and PCB due Dec 15.');
  expect(view.container.querySelector('[data-payroll-companies] a')).toBeNull();
  expect(within(screen.getByRole('list',{name:'Payroll loops in order'})).getByRole('link',{name:'Open Salary payroll loop'}))
   .toHaveAttribute('href',`/control-tower/loops/payroll-cycle/salary?period=2026-11&company=${fx.A}`);
 });

 it('an HR administrator of one company sees that company only, with no company filter',async()=>{
  state.session=SESSIONS.hrAdmin;state.scope='company';
  const view=wrap('en',await cycle());
  expect(view.container.querySelector('[data-company-filter]')).toBeNull();
  expect(rows(view.container,'[data-payroll-companies]').map(row=>row[0])).toEqual(['Fictional A Sdn Bhd']);
  expect(text(view.container.querySelector('[data-page-header]'))).toContain('Cut-off Nov 20 · pay day Nov 28');
 });

 it('the Salary payroll loop\'s page: each run\'s checks, who closed it, and a disposition per flag that changes no pay',async()=>{
  state.session=SESSIONS.groupAdmin;
  const view=wrap('en',await salary({period:'2026-10',saved:'disposition'}));
  expect(state.reads).toEqual(['salary']);
  expect(screen.getByRole('heading',{level:1,name:'Salary payroll loop: October 2026'})).toBeTruthy();
  expect(text(view.container.querySelector('[data-page-header]'))).toContain('Prepare in every company');
  expect(screen.getByRole('status').textContent).toBe('Disposition recorded.');
  expect(rows(view.container,'[data-salary-runs]')).toEqual([
   ['Salary run 1','Processed 42 employees','2 exceptions open','12 people changed 2 people over the threshold Salary change (3), Overtime hours (8)','Rule version 2026.1 Newer rule: PCB','Not closed yet','Total does not match net pay'],
   ['Bonus run 2','Closed 5 employees','No exceptions open','0 people changed','Rule version 2026.1','Closed by Aisyah Fictional Reopened once after close','Matches net pay and headcount']]);
  expect(view.container.querySelector('[data-salary-run="b-1"] a')).toHaveAttribute('href','/payroll/b-1');
  expect(view.container.querySelector('[data-salary-run="b-1"] a[href="/payroll/b-1/anomalies"]')).not.toBeNull();
  expect(rows(view.container,'[data-swing-flags]').map(row=>row.slice(0,3))).toEqual([
   ['Ravi Fictional Fictional A Sdn Bhd','Up 31.1% Threshold ±15%','Salary change Salary change'],
   ['Mei Ling Fictional Fictional A Sdn Bhd','Down 23.3% Threshold ±15%','Pay item Meal Allowance']]);
  // The decided flag shows its disposition and who recorded it; the open one offers the two dispositions.
  expect([...view.container.querySelectorAll('[data-disposition]')].map(el=>[el.getAttribute('data-disposition'),parts(el)])).toEqual([['expected','Expected By Siti Fictional']]);
  const forms=[...view.container.querySelectorAll('[data-swing-flags] form')];
  expect(forms.map(form=>[...form.querySelectorAll('input')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`))).toEqual([
   ['case=00000000-0000-4000-8000-00000000f001','disposition=expected','period=2026-10'],['case=00000000-0000-4000-8000-00000000f001','disposition=problem','period=2026-10']]);
  expect([...view.container.querySelectorAll('[data-swing-flags] button')].map(button=>button.getAttribute('aria-label'))).toEqual(['Expected · Ravi Fictional','Real problem · Ravi Fictional']);
  // Nothing on the page starts, approves or closes payroll.
  expect(text(view.container)).not.toMatch(/\b(Run payroll|Approve run|Close run)\b/);
  expect(text(view.container)).toContain('The net-swing threshold starts at ±15%.');
  coarse(view.container);
 });

 it('the settings page: interval and threshold per company, the proposals with their evidence, and every change',async()=>{
  state.session=SESSIONS.groupAdmin;
  const view=wrap('en',await settings({saved:'approved'}));
  expect(state.reads).toEqual(['settings']);
  expect(screen.getByRole('heading',{level:1,name:'Payroll cycle settings'})).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Proposal approved. It applies from the next run.');
  const company=view.container.querySelector(`[data-settings-company="${fx.A}"]`)!;
  expect((company.querySelector('select[name="interval"]') as HTMLSelectElement).value).toBe('hourly');
  expect([...company.querySelectorAll('select[name="interval"] option')].map(text)).toEqual(['Checked hourly','Checked twice a day','Checked daily']);
  expect((company.querySelector('input[name="threshold"]') as HTMLInputElement).value).toBe('15');
  expect([...company.querySelectorAll('[data-exclusions] li')].map(parts)).toEqual(['Pay item Sales Commission Remove','A pay item no longer in the catalogue Remove']);
  const proposal=company.querySelector('[data-proposal="threshold"]')!;
  expect([...proposal.querySelectorAll('p')].map(text)).toEqual(['Raise the threshold from ±15% to ±20%','5 of 6 flags cleared as expected (83.33%), real problems: 1, last 30 days']);
  expect([...proposal.querySelectorAll('button')].map(button=>[text(button),button.getAttribute('aria-label')])).toEqual([
   ['Approve','Approve · Raise the threshold from ±15% to ±20%'],['Reject','Reject · Raise the threshold from ±15% to ±20%']]);
  expect([...proposal.querySelectorAll('form')].map(form=>[...form.querySelectorAll('input')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`))).toEqual([
   [`company=${fx.A}`,`proposal=${'a'.repeat(64)}`,'decision=approved'],[`company=${fx.A}`,`proposal=${'a'.repeat(64)}`,'decision=rejected']]);
  expect([...company.querySelectorAll('[data-setting-history] li')].map(text)).toEqual([
   'Version 2: Checked hourly, threshold ±15%, 1 exclusion (an approved proposal) by Aisyah Fictional, Nov 3, 2026, 11:04 PM',
   'Version 1: Checked hourly, threshold ±15%, no exclusion (set by an administrator) by Aisyah Fictional, Nov 2, 2026, 11:04 PM',
   'A proposal rejected by Daniel Fictional, Nov 1, 2026, 11:04 PM']);
  coarse(view.container);
 });

 it.each(['ms','zh','vi','ta','th'] as const)('%s: all three pages render translated, with no missing message, saying AI Centre and never Noveri',async locale=>{
  state.locale=locale;state.session=SESSIONS.groupAdmin;
  const copy=messagesFor(locale);
  for(const page of [cycle,salary,settings]){
   const view=wrap(locale,await page({saved:'setting',error:'changed'}));
   expect(screen.getAllByRole('heading',{level:1})).toHaveLength(1);
   expect(text(view.container)).not.toMatch(/noveri/i);
   cleanup();
  }
  const view=wrap(locale,await cycle());
  expect(text(view.container.querySelector('[data-loop-card="pre-salary"] h2'))).toBe(copy.aiCentre.payrollCycle.pre.title);
  expect(text(view.container.querySelector('[data-loop-card="audit"] h2'))).toBe(copy.aiCentre.payrollCycle.audit.title);
 });
});
