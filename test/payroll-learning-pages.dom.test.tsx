/** @vitest-environment jsdom */
/** Payroll history learning (P2) — the evidence lines on the Salary payroll loop's page and in a run's anomaly queue,
 * "Learned this cycle" on the Payroll cycle page, and the learning switch on the Payroll cycle settings page (a group
 * administrator switches it on, any payroll administrator off, classify never here), rendered per role from fictional reads (the services are replaced by
 * fixtures; their behaviour is test/payroll-learning.test.ts).
 *
 * The guard is the existing requireAdmin: an employee or a manager is sent away before any read, learning's included. A
 * payroll administrator sees "Usual for this person: within / above / below range from N runs" with the exact usual range
 * under a flag that has evidence, and nothing under one that has none; the anomaly queue does the same per flagged person;
 * "Learned this cycle" gives counts only per company, a dash for a company whose learning is off, and one line when it is
 * off for every company shown. Expected text is written out from the fixture through the real catalogues; every locale
 * renders with no missing message, says AI Centre (never Noveri), and the new lines carry no control. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
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
const LOCALES:readonly Locale[]=['en','ms','zh','vi','ta','th'];
const CATALOGUES={en,ms,zh,vi:vi_,ta,th};
const messagesFor=(locale:Locale)=>withAiCentre(locale,CATALOGUES[locale] as Record<string,unknown>) as Record<string,unknown>;
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'ta'|'th',session:null as unknown,reads:[] as string[],learned:null as unknown,learningSettings:null as unknown}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator:translator,createFormatter:formatter}=await import('next-intl');
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const all={en:(await import('../messages/en.json')).default,ms:(await import('../messages/ms.json')).default,zh:(await import('../messages/zh.json')).default,
  vi:(await import('../messages/vi.json')).default,ta:(await import('../messages/ta.json')).default,th:(await import('../messages/th.json')).default};
 return {getTranslations:async(namespace:any)=>translator({locale:state.locale,messages:merge(state.locale,all[state.locale] as any) as any,namespace,onError:error=>{throw error;}}),
  getFormatter:async()=>formatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'}),getLocale:async()=>state.locale};
});
vi.mock('next/navigation',()=>({
 redirect:vi.fn((url:string)=>{throw Object.assign(Error('NEXT_REDIRECT'),{url});}),
 notFound:vi.fn(()=>{throw Object.assign(Error('NEXT_NOT_FOUND'),{notFound:true});}),
 usePathname:()=>'/control-tower/loops/payroll-cycle',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),
}));
vi.mock('../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>true,isModuleEnabledOrFalse:()=>true}));
vi.mock('../app/control-tower/loops/payroll-cycle/actions',()=>({recordSwingDispositionAction:vi.fn(),setPayrollLoopSettingAction:vi.fn(),decideThresholdProposalAction:vi.fn(),
 disposeSwingGroupAction:vi.fn(),resolveAcknowledgedBlockAction:vi.fn(),acknowledgeCheckAction:vi.fn(),revokeAcknowledgementAction:vi.fn(),decideRuleProposalAction:vi.fn(),
 setPayrollLearningModeAction:vi.fn()}));
vi.mock('../app/payroll/actions',()=>({evaluateAnomaliesAction:vi.fn(),narrateAnomalyAction:vi.fn(),proposeHypothesesAction:vi.fn(),resolveAnomalyAction:vi.fn()}));
vi.mock('../core/loops/grouped-dispositions',async importOriginal=>({...(await importOriginal<typeof import('../core/loops/grouped-dispositions')>()),acknowledgedBlocks:async()=>[]}));
const fx=vi.hoisted(()=>{
 const A='00000000-0000-4000-8000-0000000000c1',B='00000000-0000-4000-8000-0000000000c2';
 const RAVI='00000000-0000-4000-8000-0000000000e1',MEI='00000000-0000-4000-8000-0000000000e2';
 const flag=(caseId:string,employmentId:string,personName:string,swingBp:number)=>({caseId,companyId:A,companyName:'Fictional A Sdn Bhd',employmentId,personName,payPeriod:'2026-10',swingBp,
  direction:'up',pattern:'cause:other',thresholdBp:1500,causes:[],state:'open',closeReason:null,disposition:null});
 const salary={period:'2026-10',today:'2026-11-14',allowed:[{companyId:A,companyName:'Fictional A Sdn Bhd'}],filter:null,loop:{on:true,stopped:false},
  companies:[{companyId:A,companyName:'Fictional A Sdn Bhd',cutOff:'2026-10-20',thresholdBp:1500,startOpen:false,runs:[]}],
  flags:[flag('00000000-0000-4000-8000-00000000f001',RAVI,'Ravi Fictional',2500),flag('00000000-0000-4000-8000-00000000f002',MEI,'Mei Ling Fictional',1800)],patternNames:{}};
 const preSalary={state:'done',payPeriod:'2026-11',cutOff:'2026-11-20',from:'2026-11-01',daysToCutOff:6,lastCheckedAt:null,interval:'daily',checks:[]};
 const company=(companyId:string,companyName:string)=>({companyId,companyName,payDay:'2026-11-28',preSalary,salary:{state:'before_cut_off',cutOff:'2026-11-20',runs:[]}});
 const overview={period:'2026-11',today:'2026-11-14',allowed:[{companyId:A,companyName:'Fictional A Sdn Bhd'},{companyId:B,companyName:'Fictional B Sdn Bhd'}],filter:null,
  companies:[company(A,'Fictional A Sdn Bhd'),company(B,'Fictional B Sdn Bhd')],loops:{preSalary:{on:true,stopped:false},salary:{on:true,stopped:false}},history:[],people:[],audit:null,statutoryDue:'2026-12-15'};
 const counts=(stable:number,provisional:number,none:number,rebasing:number,contradicted:number)=>({stable,provisional,none,rebasing,contradicted});
 const learned={period:'2026-11',companies:[{companyId:A,companyName:'Fictional A Sdn Bhd',mode:'evidence',learnedOn:'2026-11-13',people:counts(12,3,7,1,2)},
  {companyId:B,companyName:'Fictional B Sdn Bhd',mode:'off',learnedOn:null,people:counts(0,0,0,0,0)}]};
 const allOff={period:'2026-11',companies:[{companyId:A,companyName:'Fictional A Sdn Bhd',mode:'off',learnedOn:null,people:counts(0,0,0,0,0)}]};
 const evidence=new Map([[RAVI,{basis:'month_total',judgement:'above',runs:7,status:'stable',low:400000,high:420000,value:450000}]]);
 const queueEvidence=new Map([[MEI,{basis:'regular',judgement:'below',runs:4,status:'provisional',low:250000,high:250000,value:240000}]]);
 const finding={id:'f-1',detectorId:'net-swing',severity:'review',facts:{netSwingPct:18},suggestedAction:'',narrative:null};
 const row=(verdictId:string,employmentId:string,employeeName:string)=>({verdictId,employmentId,employeeName,employeeCode:null,disposition:'review',computedAt:new Date('2026-11-01T00:00:00Z'),
  resolution:null,resolvedAt:null,detectorsRunCount:11,detectorsSkipped:[],findings:[finding]});
 const queue=[row('v-1',RAVI,'Ravi Fictional'),row('v-2',MEI,'Mei Ling Fictional')];
 class PayrollCycleRefused extends Error{constructor(readonly reason:string){super(reason);}}
 // The settings page: one company with default settings, and its learning mode and history.
 const settings={companies:[{companyId:A,companyName:'Fictional A Sdn Bhd',setting:{companyId:A,version:0,interval:'daily',thresholdBp:1500,exclusions:[],remindersEnabled:true,
  source:'default',changedByUserId:null,changedAt:null},proposals:[],history:[],decisions:[],acknowledgements:[],ruleProposals:[]}],patternNames:{}};
 const at=(iso:string)=>new Date(iso);
 const learningOff=new Map([[A,{companyId:A,mode:'off',version:0,history:[]}]]);
 const learningOn=new Map([[A,{companyId:A,mode:'evidence',version:3,history:[{version:3,mode:'evidence',source:'admin',by:'Aisyah Fictional',at:at('2026-11-03T15:04:00Z')},
  {version:2,mode:'off',source:'admin',by:'Daniel Fictional',at:at('2026-11-02T15:04:00Z')},{version:1,mode:'evidence',source:'admin',by:null,at:at('2026-11-01T15:04:00Z')}]}]]);
 return {A,B,RAVI,MEI,salary,overview,learned,allOff,evidence,queueEvidence,queue,PayrollCycleRefused,settings,learningOff,learningOn};
});
vi.mock('../core/loops/payroll-cycle-views',()=>({PayrollCycleRefused:fx.PayrollCycleRefused,
 payrollCycleOverview:async()=>{state.reads.push('overview');return fx.overview;},
 salaryLoopPage:async()=>{state.reads.push('salary');return fx.salary;},
 payrollLoopSettingsPage:async()=>{state.reads.push('settings');return fx.settings;}}));
vi.mock('../core/payroll-learning/mode',async importOriginal=>({...(await importOriginal<typeof import('../core/payroll-learning/mode')>()),
 learningSettingsView:async()=>{state.reads.push('learningSettings');return state.learningSettings??fx.learningOff;}}));
vi.mock('../core/payroll-learning/evidence',()=>({
 swingFlagEvidence:async()=>{state.reads.push('swingEvidence');return fx.evidence;},
 runEvidence:async()=>{state.reads.push('runEvidence');return fx.queueEvidence;}}));
vi.mock('../core/payroll-learning/status',async importOriginal=>({...(await importOriginal<typeof import('../core/payroll-learning/status')>()),
 learnedThisCycle:async()=>{state.reads.push('learned');return state.learned;}}));
vi.mock('../db/client',async importOriginal=>({...(await importOriginal<typeof import('../db/client')>()),withTenant:async(_s:unknown,fn:(tx:unknown)=>unknown)=>fn({})}));
vi.mock('../core/payroll',async importOriginal=>({...(await importOriginal<typeof import('../core/payroll')>()),batchHeader:async()=>({id:'00000000-0000-4000-8000-0000000000b1'})}));
vi.mock('../core/payroll-anomaly',async importOriginal=>({...(await importOriginal<typeof import('../core/payroll-anomaly')>()),
 anomalyQueue:async()=>fx.queue,
 anomalyMetrics:async()=>({total:2,autoClearRate:0,coverage:1,flaggedPerThousand:1000,unresolvedFlagged:2,block:0,review:2}),
 evaluateCircuitBreaker:async()=>({tripped:false,skippedReason:null,movementPct:1,thresholdPct:30}),
 thresholdsInForce:async()=>({thresholds:[],anyUntuned:false})}));
import PayrollCyclePage from '../app/control-tower/loops/payroll-cycle/page';
import SalaryLoopPage from '../app/control-tower/loops/payroll-cycle/salary/page';
import AnomaliesPage from '../app/payroll/[batchId]/anomalies/page';
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
/** An element's text with its child nodes (a line and its block span) joined by a space. */
const parts=(el:Element|null|undefined)=>el?[...el.childNodes].map(node=>text(node)).filter(Boolean).join(' '):'';
const cycle=()=>PayrollCyclePage({searchParams:Promise.resolve({})});
const salary=()=>SalaryLoopPage({searchParams:Promise.resolve({})});
const anomalies=()=>AnomaliesPage({params:Promise.resolve({batchId:'00000000-0000-4000-8000-0000000000b1'}),searchParams:Promise.resolve({})});
const settingsPage=(query:Record<string,string>={})=>PayrollLoopSettingsPage({searchParams:Promise.resolve(query)});
afterEach(()=>{cleanup();state.locale='en';state.session=null;state.reads=[];state.learned=null;state.learningSettings=null;});

describe('who sees learning',()=>{
 it.each(['employee','manager'] as const)('%s is refused before any read, learning\'s included',async role=>{
  state.session=SESSIONS[role];
  await expect(cycle()).rejects.toMatchObject({url:'/'});
  await expect(salary()).rejects.toMatchObject({url:'/'});
  await expect(anomalies()).rejects.toMatchObject({url:'/'});
  await expect(settingsPage()).rejects.toMatchObject({url:'/'});
  expect(state.reads).toEqual([]);
 });
});

describe('the evidence lines',()=>{
 it.each(['hrAdmin','groupAdmin'] as const)('a payroll administrator (%s) sees the usual range under a flag with evidence, and nothing under one without',async role=>{
  state.session=SESSIONS[role];
  const view=wrap('en',await salary());
  expect(state.reads).toEqual(['salary','swingEvidence']);
  const [ravi,mei]=[...view.container.querySelectorAll('[data-swing-flags] tbody tr')];
  const line=ravi.querySelector('[data-learning-evidence]')!;
  expect(line.getAttribute('data-learning-evidence')).toBe('above');
  expect(parts(line)).toBe('Usual for this person: above range from 7 runs Usual range 4,000.00 to 4,200.00');
  expect(line.querySelector('button,a,input,form')).toBeNull();
  expect(mei.querySelector('[data-learning-evidence]')).toBeNull();
 });
 it('says the same in a run\'s anomaly queue, per flagged person',async()=>{
  state.session=SESSIONS.groupAdmin;
  const view=wrap('en',await anomalies());
  expect(state.reads).toContain('runEvidence');
  const lines=[...view.container.querySelectorAll('[data-learning-evidence]')];
  expect(lines.map(el=>[el.getAttribute('data-learning-evidence'),parts(el)])).toEqual([['below','Usual for this person: below range from 4 runs Usual range 2,500.00 to 2,500.00']]);
  // Beside the facts, never in place of them: both flagged people keep their findings and their way to resolve them, which
  // since the AI Centre restructure (owner decision 28) is a link to Exceptions, the one place an exception is resolved.
  expect([...view.container.querySelectorAll('[data-resolve-on-exceptions]')].map(a=>[a.textContent,a.getAttribute('href')]))
   .toEqual([['Resolve on Exceptions','/control-tower/exceptions'],['Resolve on Exceptions','/control-tower/exceptions']]);
  expect(view.container.querySelectorAll('form button[name="resolution"]')).toHaveLength(0);
 });
 it.each(LOCALES)('renders in %s with no missing message, and never says Noveri',async locale=>{
  state.session=SESSIONS.groupAdmin;state.locale=locale;
  const view=wrap(locale,await salary());
  const line=view.container.querySelector('[data-learning-evidence]')!;
  expect(text(line)).toMatch(/7/);expect(text(line)).toMatch(/4[.,\s ]?000/);
  expect(view.container.textContent).not.toMatch(/Noveri/);
  cleanup();
  const queue=wrap(locale,await anomalies());
  expect(text(queue.container.querySelector('[data-learning-evidence]'))).toMatch(/4/);
 });
});

describe('"Learned this cycle" on the Payroll cycle page',()=>{
 it('gives counts only per company, a dash where learning is off, and when it last learned',async()=>{
  state.session=SESSIONS.groupAdmin;state.learned=fx.learned;
  const view=wrap('en',await cycle());
  expect(state.reads).toEqual(['overview','learned']);
  const card=view.container.querySelector('[data-learned-cycle]')!;
  expect(parts(card.querySelector('[data-ui-section-header]'))).toMatch(/^Learned this cycle How many people’s usual pay AI Centre has learned/);
  expect(text(card)).toContain('Counts only. A usual range explains a flag; it never changes a figure or a check.');
  expect([...card.querySelectorAll('thead th')].map(text)).toEqual(['Company','Learning','Settled (6+ runs)','Provisional (3–5)','Not yet (under 3)',
   'Relearning after a salary change','Pay has moved','Last learned']);
  expect([...card.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('th,td')].map(text))).toEqual([
   ['Fictional A Sdn Bhd','Evidence lines','12','3','7','1','2','Nov 13'],
   ['Fictional B Sdn Bhd','Off','—','—','—','—','—','Not yet']]);
  // Counts only: no person, no amount, and no control.
  expect(text(card)).not.toMatch(/Ravi|Mei|RM|\d\.\d\d/);
  expect(card.querySelector('button,input,select,form')).toBeNull();
 });
 it('says learning is off in one line when it is off for every company shown, and shows nothing when the read gives nothing',async()=>{
  state.session=SESSIONS.hrAdmin;state.learned=fx.allOff;
  const off=wrap('en',await cycle());
  expect(text(off.container.querySelector('[data-learning-off]'))).toBe('Learning from payroll history is off for these companies.');
  expect(off.container.querySelector('[data-learned-cycle] table')).toBeNull();
  cleanup();state.learned=null;
  const none=wrap('en',await cycle());
  expect(none.container.querySelector('[data-learned-cycle]')).toBeNull();
 });
 it.each(LOCALES)('renders in %s with no missing message, and never says Noveri',async locale=>{
  state.session=SESSIONS.groupAdmin;state.learned=fx.learned;state.locale=locale;
  const view=wrap(locale,await cycle());
  const card=view.container.querySelector('[data-learned-cycle]')!;
  expect([...card.querySelectorAll('tbody tr')][0].querySelectorAll('td')[1].textContent).toBe('12');
  expect(view.container.textContent).not.toMatch(/Noveri/);
 });
});

describe('the learning switch on the Payroll cycle settings page',()=>{
 const section=(container:Element)=>container.querySelector('[data-learning-settings]')!;
 const buttons=(el:Element)=>[...el.querySelectorAll('button')].map(text);
 const hidden=(el:Element)=>[...el.querySelectorAll('input[type="hidden"]')].map(input=>[input.getAttribute('name'),input.getAttribute('value')]);
 it('a group administrator sees the mode, switches evidence lines on, and is told classify comes only from a proposal',async()=>{
  state.session=SESSIONS.groupAdmin;
  const view=wrap('en',await settingsPage());
  expect(state.reads).toEqual(['settings','learningSettings']);
  const el=section(view.container);
  expect(el.getAttribute('data-learning-settings')).toBe('off');
  expect(text(el.querySelector('h3'))).toBe('Learning from payroll history');
  expect(text(el.querySelector('[data-learning-current]'))).toBe('Now: Off');
  expect(buttons(el)).toEqual(['Switch on evidence lines']);
  expect(hidden(el)).toEqual([['company',fx.A],['mode','evidence']]);
  expect(el.querySelector('[data-learning-group-only]')).toBeNull();
  expect(text(el)).toContain('Classify is reached only through an approved proposal backed by a backtest. It is not available yet.');
  expect(text(el)).toContain('Never switched on.');
  for(const button of el.querySelectorAll('button'))expect(button.className).toContain('pointer-coarse:min-h-11');
 });
 it('an HR administrator of one company cannot switch it on, but switches it off and sees every change with who made it',async()=>{
  state.session=SESSIONS.hrAdmin;
  const off=wrap('en',await settingsPage());
  expect(buttons(section(off.container))).toEqual([]);
  expect(text(section(off.container).querySelector('[data-learning-group-only]'))).toBe('A group administrator switches learning on. You can switch it off.');
  cleanup();state.learningSettings=fx.learningOn;
  const on=wrap('en',await settingsPage());
  const el=section(on.container);
  expect(el.getAttribute('data-learning-settings')).toBe('evidence');
  expect(text(el.querySelector('[data-learning-current]'))).toBe('Now: Evidence lines');
  expect(buttons(el)).toEqual(['Switch off']);
  expect(hidden(el)).toEqual([['company',fx.A],['mode','off']]);
  const rows=[...el.querySelectorAll('[data-learning-history] li')].map(text);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatch(/^Version 3: Evidence lines, by Aisyah Fictional, Nov 3, 2026/);
  expect(rows[1]).toMatch(/^Version 2: Off, by Daniel Fictional, Nov 2, 2026/);
  // Who switched it, where the viewer may read their name; a person otherwise.
  expect(rows[2]).toMatch(/^Version 1: Evidence lines, by A person, Nov 1, 2026/);
 });
 it('says what happened after a change and why a switch was refused',async()=>{
  state.session=SESSIONS.groupAdmin;
  const saved=wrap('en',await settingsPage({saved:'learning'}));
  expect(text(saved.container.querySelector('[role="status"]'))).toBe('Saved. Learning follows it from its next run.');
  cleanup();
  const refused=wrap('en',await settingsPage({error:'learningGroup'}));
  expect(refused.container.textContent).toContain('Only a group administrator can switch learning on.');
 });
 it.each(LOCALES)('renders in %s with no missing message, and never says Noveri',async locale=>{
  state.session=SESSIONS.groupAdmin;state.locale=locale;state.learningSettings=fx.learningOn;
  const view=wrap(locale,await settingsPage({saved:'learning'}));
  expect(section(view.container).querySelectorAll('[data-learning-history] li')).toHaveLength(3);
  expect(view.container.textContent).not.toMatch(/Noveri/);
 });
});
