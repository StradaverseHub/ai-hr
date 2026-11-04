/** @vitest-environment jsdom */
/** AI Centre › Operations › Loops lists the three payroll loops (owner, 4 November 2026: the Audit loop was reachable only
 * from the Payroll cycle page's third column, and the Loops table lists only the six autonomy loops).
 *
 * Rendered per role from fictional reads (core/loops/views.ts and core/loops/payroll-cycle-views.ts are fixtures; the real
 * services are covered by test/teras-loops.test.ts and test/payroll-cycle-loops.test.ts):
 *  - an employee or a manager is refused by the page's requireAdmin before any read, the payroll read included;
 *  - an HR or group administrator sees "Payroll loops in order" above the six loops' table: Pre-salary, Salary payroll and
 *    Audit, each linking to its own page with this month's status, the status the Payroll cycle page shows;
 *  - the six loops' table is unchanged and still comes after it;
 *  - the statuses stream: until the read returns, and when it fails, the names and links show without a status;
 *  - every link keeps a 44px target on a coarse pointer and prefetches its page in full on intent, as the tab rows do;
 *  - every locale renders from the existing reviewed catalogue with no missing message, and says AI Centre, never Noveri.
 * Expected English text is written out; the other locales are compared with their own catalogue entries. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {Suspense,isValidElement,type ReactElement,type ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {withAiCentre} from './helpers/ai-centre-messages';
import {resolveServerTree} from './helpers/server-tree';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi_ from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';

type Locale='en'|'ms'|'zh'|'vi'|'ta'|'th';
const LOCALES:readonly Locale[]=['en','ms','zh','vi','ta','th'];
const CATALOGUES={en,ms,zh,vi:vi_,ta,th};
const messagesFor=(locale:Locale)=>withAiCentre(locale,CATALOGUES[locale] as Record<string,unknown>) as typeof en & {aiCentre:Record<string,any>;payrollAudit:Record<string,any>};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'ta'|'th',session:null as unknown,reads:[] as string[],payroll:null as unknown,payrollFails:false}));
vi.mock('next/link',()=>({
 default:({prefetch,children,...rest}:{prefetch?:unknown;children?:ReactNode}&Record<string,unknown>)=><a data-prefetch={String(prefetch)} {...(rest as Record<string,unknown>)}>{children}</a>,
}));
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
 usePathname:()=>'/control-tower/loops',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),
}));
vi.mock('../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>true,isModuleEnabledOrFalse:()=>true}));
vi.mock('../app/control-tower/loops/actions',()=>({setLoopSwitchAction:vi.fn(),setLoopPauseAction:vi.fn()}));
vi.mock('../core/loops/autonomy-views',()=>({loopLevelSummaries:async()=>({})}));
const fx=vi.hoisted(()=>{
 const LOOPS=['loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry','loop_salary_payroll'];
 const rows=()=>LOOPS.map(id=>({id,level:'prepare',on:false,stopped:false,running:false,sponsor:null,lastRun:null,prepared:0,confirmed:0,changed:0,
  correctionRate:null,proposesValue:false,openNow:0,waitingNow:0,pausedCompanies:0}));
 class LoopViewRefused extends Error{constructor(readonly reason:string){super(reason);}}
 const A='00000000-0000-4000-8000-0000000000c1',B='00000000-0000-4000-8000-0000000000c2';
 const company=(companyId:string,pre:string,days:number,salary:string)=>({companyId,companyName:companyId===A?'Fictional A Sdn Bhd':'Fictional B Sdn Bhd',payDay:'2026-11-28',
  preSalary:{state:pre,payPeriod:'2026-11',cutOff:'2026-11-20',from:'2026-11-01',daysToCutOff:days,lastCheckedAt:null,interval:'daily',checks:[]},salary:{state:salary,cutOff:'2026-11-20',runs:[]}});
 const audit=(done:readonly boolean[])=>({payPeriod:'2026-11',dueDate:'2026-12-15',level:'prepare',loop:{on:true,sponsorUserId:null,sponsorName:null},
  companies:done.map((d,i)=>({companyId:i?B:A,done:d})),totals:{payslips:0,released:0,opened:0,formsPrepared:0,formsFiled:0,forms:0,bankFiles:0,corrections:0,
   correctionsWithoutRootCause:0,openFindings:0,repeatIssues:0,captures:0,companiesDone:done.filter(Boolean).length},canCapture:true});
 /** A month in progress: Pre-salary running in A (6 days to cut-off) and done in B; Salary payroll waits for the cut-off; Audit open. */
 const running=()=>({period:'2026-11',statutoryDue:'2026-12-15',filter:null,allowed:[],history:[],people:[],
  companies:[company(A,'open',6,'before_cut_off'),company(B,'done',6,'before_cut_off')],audit:audit([false,true])});
 /** A closed month: every loop done in every company. */
 const closed=()=>({...running(),companies:[company(A,'done',-3,'done'),company(B,'done',-3,'done')],audit:audit([true,true])});
 return {rows,LoopViewRefused,running,closed};
});
vi.mock('../core/loops/views',()=>({LoopViewRefused:fx.LoopViewRefused,loopsOverview:async()=>{state.reads.push('overview');return {rows:fx.rows(),canSwitch:false,windowDays:30};}}));
vi.mock('../core/loops/payroll-cycle-views',()=>({payrollCycleOverview:async()=>{state.reads.push('payroll');if(state.payrollFails)throw Error('refused');return state.payroll;}}));
import LoopsPage from '../app/control-tower/loops/page';
import {PayrollLoopsList,PAYROLL_LOOP_HREFS} from '../app/control-tower/loops/payroll-loops-list';
import {INTENT_DWELL_MS} from '../components/intent-link';

const TENANT='00000000-0000-4000-8000-0000000000a1',COMPANY='00000000-0000-4000-8000-0000000000c1';
const SESSIONS={
 employee:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000001',roles:['employee'],grants:[{role:'employee',companyId:COMPANY}]},
 manager:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000002',roles:['employee','manager'],grants:[{role:'manager',companyId:COMPANY}]},
 hrAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000003',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:COMPANY}]},
 groupAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000004',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
} as const;
const wrap=(locale:Locale,node:ReactNode)=>render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} onError={error=>{throw error;}} timeZone="Asia/Kuala_Lumpur">
 <main className="relative min-w-0"><div className="min-w-0">{node}</div></main></NextIntlClientProvider>);
const text=(el:Node|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const page=async()=>resolveServerTree(await LoopsPage({searchParams:Promise.resolve({})}));
const section=(container:HTMLElement)=>container.querySelector<HTMLElement>('[data-payroll-loops-list]')!;
const rowsOf=(container:HTMLElement)=>[...section(container).querySelectorAll('li')].map(li=>({
 key:li.getAttribute('data-payroll-loop'),name:text(li.querySelector('a')),href:li.querySelector('a')?.getAttribute('href'),
 state:li.querySelector('[data-loop-state]')?.getAttribute('data-loop-state')??null,status:text(li.querySelector('[data-loop-state]'))||null}));
beforeEach(()=>{state.payroll=fx.running();});
afterEach(()=>{cleanup();vi.useRealTimers();state.locale='en';state.session=null;state.reads=[];state.payroll=null;state.payrollFails=false;});

describe('Operations › Loops: the three payroll loops',()=>{
 it.each(['employee','manager'] as const)('%s is refused before any read, the payroll read included',async role=>{
  state.session=SESSIONS[role];
  await expect(LoopsPage({searchParams:Promise.resolve({})})).rejects.toMatchObject({url:'/'});
  expect(state.reads).toEqual([]);
 });

 it.each(['hrAdmin','groupAdmin'] as const)('%s sees Pre-salary, Salary payroll and Audit in order, each with its status and its page, above the six loops',async role=>{
  state.session=SESSIONS[role];
  const view=wrap('en',await page());
  // The payroll read starts with the table's own read.
  expect(state.reads).toEqual(['payroll','overview']);
  const list=section(view.container);
  expect(list.getAttribute('data-payroll-loops-list')).toBe('status');
  expect(within(list).getByRole('heading',{level:2,name:'Payroll loops in order'})).toBeTruthy();
  expect(rowsOf(view.container)).toEqual([
   {key:'pre',name:'1 · Pre-salary loop',href:'/control-tower/loops/payroll-cycle',state:'open',status:'Running · 6 days to cut-off'},
   {key:'salary',name:'2 · Salary payroll loop',href:'/control-tower/loops/payroll-cycle/salary',state:'before_cut_off',status:'Starts at cut-off'},
   {key:'audit',name:'3 · Audit loop',href:'/control-tower/loops/loop_payroll_audit',state:'after_pay_day',status:'After pay day'},
  ]);
  // Attention where a person should look; nothing is marked done yet.
  expect(list.querySelector('[data-loop-state="open"]')?.className).toContain('text-amber-700');
  expect(list.querySelector('[data-loop-state="after_pay_day"]')?.className).not.toContain('text-emerald-700');
  // The six loops' table is unchanged and still follows.
  const table=view.container.querySelector('[data-loops-table]')!;
  expect([...table.querySelectorAll('tbody tr')].map(row=>row.getAttribute('data-loop-row'))).toEqual(['loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data',
   'loop_missed_clock_outs','loop_document_expiry','loop_salary_payroll']);
  expect(list.compareDocumentPosition(table)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The Payroll cycle header link is still there.
  expect(view.container.querySelector('[data-page-header] a[data-payroll-cycle-link]')).toHaveAttribute('href','/control-tower/loops/payroll-cycle');
 });

 it('a closed month shows every payroll loop done',async()=>{
  state.session=SESSIONS.groupAdmin;state.payroll=fx.closed();
  const view=wrap('en',await page());
  expect(rowsOf(view.container).map(row=>[row.key,row.state,row.status])).toEqual([['pre','done','Done'],['salary','done','Done'],['audit','done','Done']]);
  for(const pill of section(view.container).querySelectorAll('[data-loop-state]'))expect(pill.className).toContain('text-emerald-700');
 });

 it('the statuses stream: names and links first, and a failed read leaves them without a status',async()=>{
  state.session=SESSIONS.groupAdmin;
  // While the read is pending, the section's fallback is the names and links alone.
  const element=PayrollLoopsList({overview:new Promise(()=>{})}) as ReactElement<{fallback:ReactNode;children:ReactNode}>;
  expect(isValidElement(element)&&element.type).toBe(Suspense);
  const pending=wrap('en',await resolveServerTree(element.props.fallback));
  expect(section(pending.container).getAttribute('data-payroll-loops-list')).toBe('names');
  expect(rowsOf(pending.container).map(row=>[row.name,row.href,row.status])).toEqual([['1 · Pre-salary loop','/control-tower/loops/payroll-cycle',null],
   ['2 · Salary payroll loop','/control-tower/loops/payroll-cycle/salary',null],['3 · Audit loop','/control-tower/loops/loop_payroll_audit',null]]);
  cleanup();
  state.payrollFails=true;
  const failed=wrap('en',await page());
  expect(section(failed.container).getAttribute('data-payroll-loops-list')).toBe('names');
  expect(section(failed.container).querySelectorAll('[data-loop-state]')).toHaveLength(0);
  expect(rowsOf(failed.container).map(row=>row.href)).toEqual(Object.values(PAYROLL_LOOP_HREFS));
  // The table renders as before.
  expect(failed.container.querySelectorAll('[data-loops-table] tbody tr')).toHaveLength(6);
 });

 it('every payroll loop link keeps a 44px target on a coarse pointer and prefetches its page in full on intent',async()=>{
  state.session=SESSIONS.groupAdmin;
  const view=wrap('en',await page());
  vi.useFakeTimers();
  const links=[...section(view.container).querySelectorAll<HTMLAnchorElement>('a')];
  expect(links).toHaveLength(3);
  for(const link of links){expect(link.className).toContain('pointer-coarse:min-h-11');expect(link.getAttribute('data-prefetch')).toBe('null');}
  fireEvent.focus(links[0]);expect(links[0].getAttribute('data-prefetch')).toBe('true');
  fireEvent.pointerEnter(links[2]);act(()=>{vi.advanceTimersByTime(INTENT_DWELL_MS);});expect(links[2].getAttribute('data-prefetch')).toBe('true');
  // The six loops' own links prefetch the same way.
  const loopLink=view.container.querySelector<HTMLAnchorElement>('[data-loops-table] a[href="/control-tower/loops/loop_payroll_inputs"]')!;
  expect(loopLink.getAttribute('data-prefetch')).toBe('null');fireEvent.touchStart(loopLink);expect(loopLink.getAttribute('data-prefetch')).toBe('true');
 });

 it.each(LOCALES)('%s: renders from the reviewed catalogue with no missing message, and says AI Centre, never Noveri',async locale=>{
  state.session=SESSIONS.groupAdmin;state.locale=locale;
  const view=wrap(locale,await page());
  const m=messagesFor(locale),p=m.aiCentre.payrollCycle;
  const list=section(view.container);
  expect(text(list.querySelector('h2'))).toBe(p.loopsLabel);
  expect(rowsOf(view.container).map(row=>[row.name,row.href])).toEqual([[p.pre.title,PAYROLL_LOOP_HREFS.pre],[p.salary.title,PAYROLL_LOOP_HREFS.salary],[p.audit.title,PAYROLL_LOOP_HREFS.audit]]);
  expect(rowsOf(view.container)[1].status).toBe(p.salary.state.before_cut_off);
  expect(rowsOf(view.container)[2].status).toBe(m.payrollAudit.column.badge);
  expect(rowsOf(view.container)[0].status).toBeTruthy();
  expect(text(view.container)).not.toMatch(/noveri/i);
  expect(screen.getAllByRole('link').length).toBeGreaterThan(3);
 });
});
