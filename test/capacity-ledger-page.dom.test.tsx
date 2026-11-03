/** @vitest-environment jsdom */
/** AI v2 Phase 2, P2-4 — AI Centre › Insights › HR capacity, rendered from a fictional read (core/capacity/ledger.ts and
 * baseline.ts are replaced by fixtures; the real services are covered by test/capacity-ledger.test.ts and the
 * arithmetic by test/capacity-ledger-math.test.ts).
 *
 * The Insights tab is offered to HR and group administrators only, between Operations and Administration, and the view
 * renders the section only for an administrator. In the section: the four figures, HR time freed by month drawn to
 * scale with the shared chart and its "Autopilot started" mark, where the time came from, the method, the baseline-
 * missing state with its guided set-up, and figures a viewer may not read marked as not shown. Owner rule: no ratio of
 * HR staff to employees appears on the rendered page or in any catalogue. Every locale renders with no missing message
 * and never says Noveri; every control keeps a 44px target on a coarse pointer. Expected text is written out by hand. */
import fs from 'node:fs';
import path from 'node:path';
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
const LOCALES=['en','ms','zh','vi','ta','th'] as const;
const CATALOGUES={en,ms,zh,vi:vi_,ta,th};
const messagesFor=(locale:Locale)=>withAiCentre(locale,CATALOGUES[locale] as Record<string,unknown>) as typeof en & {aiCentre:Record<string,any>};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'ta'|'th',view:null as unknown,setup:null as unknown,reads:[] as unknown[]}));
vi.mock('next/link',()=>({default:({children,prefetch:_prefetch,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn(),usePathname:()=>'/assistant',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator:translator,createFormatter:formatter}=await import('next-intl');
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const all={en:(await import('../messages/en.json')).default,ms:(await import('../messages/ms.json')).default,zh:(await import('../messages/zh.json')).default,
  vi:(await import('../messages/vi.json')).default,ta:(await import('../messages/ta.json')).default,th:(await import('../messages/th.json')).default};
 return {getTranslations:async(namespace:any)=>translator({locale:state.locale,messages:merge(state.locale,all[state.locale] as any) as any,namespace,onError:error=>{throw error;}}),
  getFormatter:async()=>formatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'})};
});
vi.mock('../app/assistant/capacity-actions',()=>({setCapacityBaselineAction:vi.fn()}));
vi.mock('../core/capacity/ledger',()=>({capacityLedger:async(_session:unknown,input:unknown)=>{state.reads.push(['ledger',input]);return state.view;}}));
vi.mock('../core/capacity/baseline',()=>({baselineSetup:async(_session:unknown,input:unknown)=>{state.reads.push(['setup',input]);return state.setup;}}));
import {CapacityLedgerSection} from '../components/ai-centre/capacity-ledger';
import {AiCentreTabs} from '../components/ai-centre/centre-tabs';
import {isAdmin} from '../lib/authz-model';

const C1='00000000-0000-4000-8000-0000000000c1',C2='00000000-0000-4000-8000-0000000000c2';
const COMPANIES=[{id:C1,name:'Fictional Alpha Sdn Bhd'},{id:C2,name:'Fictional Beta Sdn Bhd'}];
const MONTHS=[['2026-06',0],['2026-07',0],['2026-08',0],['2026-09',870],['2026-10',1620],['2026-11',2310]] as const;
const ledger=(over:Record<string,unknown>={})=>({freedMinutes:2310,loopActions:{done:1040,changed:4},questions:212,payrollErrors:9,
 rows:[
  {item:'loop_payroll_inputs',done:3,manualMinutes:720,reviewMinutes:60,freedMinutes:660,withoutBaseline:0},
  {item:'questions_answered',done:212,manualMinutes:636,reviewMinutes:0,freedMinutes:636,withoutBaseline:0},
  {item:'loop_missed_clock_outs',done:612,manualMinutes:612,reviewMinutes:42,freedMinutes:570,withoutBaseline:0},
  {item:'loop_missing_employee_data',done:50,manualMinutes:480,reviewMinutes:36,freedMinutes:444,withoutBaseline:2},
 ],
 months:MONTHS.map(([month,freedMinutes])=>({month,freedMinutes})),companiesWithoutBaseline:[C2],...over});
const view=(over:Record<string,unknown>={},ledgerOver:Record<string,unknown>={})=>({period:'last30',periodFrom:'2026-10-05',today:'2026-11-03',companies:COMPANIES,companyId:null,
 baselines:[{companyId:C1,version:1,periodFrom:'2026-06-16',periodTo:'2026-09-14',minutesPerStaffAction:2,items:{},setAt:new Date('2026-09-14T02:00:00Z')}],
 autopilotStart:'2026-09-14',ledger:ledger(ledgerOver),...over});
const SETUP={company:{id:C2,name:'Fictional Beta Sdn Bhd'},days:90,autopilotStart:'2026-09-14',periodFrom:'2026-06-16',periodTo:'2026-09-14',
 evidence:{attendance_correction:{cases:40,completed:36,staffActions:52},profile_change:{cases:4,completed:3,staffActions:6}},minCompleted:10,current:null};

const TENANT='00000000-0000-4000-8000-0000000000a1';
const SESSIONS={
 employee:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000001',roles:['employee'],grants:[{role:'employee',companyId:C1}]},
 manager:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000002',roles:['employee','manager'],grants:[{role:'manager',companyId:C1}]},
 hrAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000003',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:C1}]},
 groupAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000004',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
} as const;
const wrap=(locale:Locale,node:ReactNode)=>render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} onError={error=>{throw error;}} timeZone="Asia/Kuala_Lumpur">
 <main className="relative min-w-0"><div className="min-w-0">{node}</div></main></NextIntlClientProvider>);
const text=(el:Node|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const parts=(el:Element)=>[...el.childNodes].map(node=>text(node)).filter(Boolean).join(' ');
const section=async(query:Record<string,string>={},session:unknown=SESSIONS.groupAdmin)=>CapacityLedgerSection({session:session as never,query});
const medium=(date:string)=>new Intl.DateTimeFormat('en',{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(`${date}T00:00:00+08:00`));
afterEach(()=>{cleanup();state.locale='en';state.view=null;state.setup=null;state.reads=[];});

/** Owner rule (3 November 2026): no "HR staff per 100 employees" ratio on any screen HR uses, in any language. */
const RATIO=[/per\s*100\b/i,/per\s+hundred/i,/staff\s+per\b/i,/staff[-\s]+to[-\s]+employee/i,/\bratio\b/i,/\bFTE\b/,/full[-\s]time\s+equivalent/i,
 /setiap\s+100/i,/nisbah/i,/每\s*(百|100)/,/比率/,/tỷ\s*lệ/i,/trên\s+100/i,/விகிதம்/,/อัตราส่วน/,/ต่อ\s*100/];

describe('the Insights tab',()=>{
 it.each([['employee',false],['manager',false],['hrAdmin',true],['groupAdmin',true]] as const)('%s: offered only to administrators, between Operations and Administration',(role,admitted)=>{
  expect(isAdmin(SESSIONS[role] as never)).toBe(admitted);
  wrap('en',<AiCentreTabs active="insights" isAdmin={admitted} />);
  const nav=screen.getByRole('navigation',{name:'AI Centre sections'});
  const links=within(nav).getAllByRole('link').map(link=>[text(link),link.getAttribute('href')]);
  if(!admitted){expect(links.map(([label])=>label)).toEqual(['Ask','Delegated jobs','How it works']);return;}
  expect(links).toEqual([['Ask','/assistant'],['Delegated jobs','/assistant?view=jobs'],['Operations','/control-tower'],['Insights','/assistant?view=insights'],
   ['Administration','/control-tower/agents/features'],['How it works','/assistant?view=how']]);
  expect(within(nav).getByRole('link',{current:'page'})).toHaveAttribute('href','/assistant?view=insights');
  for(const link of within(nav).getAllByRole('link'))expect(link.className).toContain('min-h-11');
 });

 it('renders the HR capacity section on the Insights view for administrators only',()=>{
  const page=fs.readFileSync(path.join(__dirname,'..','app/assistant/page.tsx'),'utf8');
  expect(page).toContain("{sp.view === 'insights' && admin && <CapacityLedgerSection session={s} query={sp as Readonly<Record<string, string | undefined>>} />}");
  expect(page.indexOf("if (sp.view === 'inbox')")).toBeLessThan(page.indexOf("sp.view === 'insights' && admin"));
 });
});

describe('HR capacity, as an administrator',()=>{
 it('shows the four figures, the chart drawn to scale, where the time came from and the method',async()=>{
  state.view=view();
  const rendered=wrap('en',await section({period:'last30'}));
  expect(state.reads).toEqual([['ledger',{period:'last30',companyId:undefined}]]);
  expect(screen.getByRole('heading',{level:2,name:'HR capacity'})).toBeTruthy();
  expect(text(rendered.container)).toContain('What AI Centre did for the HR teams of the companies you administer, each measured against its own baseline.');
  // Periods: links that keep the company filter, the current one marked.
  const periods=screen.getByRole('navigation',{name:'Period'});
  expect(within(periods).getAllByRole('link').map(link=>[text(link),link.getAttribute('href'),link.getAttribute('aria-current')])).toEqual([
   ['Last 30 days','/assistant?view=insights&period=last30','true'],['This quarter','/assistant?view=insights&period=quarter',null],['This year','/assistant?view=insights&period=year',null]]);
  // The company filter covers the viewer's companies.
  const select=rendered.container.querySelector('[data-capacity-company-filter] select')!;
  expect([...select.querySelectorAll('option')].map(option=>[option.getAttribute('value'),text(option)])).toEqual([['','All your companies (2)'],[C1,'Fictional Alpha Sdn Bhd'],[C2,'Fictional Beta Sdn Bhd']]);
  // Tiles: 2310 minutes = 38.5 h, 38.5 / 8 = 4.8 working days; 4 of 1040 changed = 0.4%.
  expect([...rendered.container.querySelectorAll('[data-stat-cells] > div')].map(cell=>[text(cell.querySelector('dt')),parts(cell.querySelector('dd')!)])).toEqual([
   ['HR time freed','38.5 h about 4.8 working days'],
   ['Payroll errors caught before the run','9 each would have needed a correction'],
   ['Loop actions completed','1,040 0.4% changed by a person'],
   ['Employee questions answered','212 answered at once, any time of day']]);
  // One company has no baseline yet: said, with its guided way to set it.
  const partial=rendered.container.querySelector('[data-baseline-partial]')!;
  expect(text(partial)).toContain('1 company has no baseline yet, so its work counts as done without freeing time.');
  expect(within(partial as HTMLElement).getByRole('link',{name:'Set the baseline for Fictional Beta Sdn Bhd'})).toHaveAttribute('href',`/assistant?view=insights&period=last30&setup=${C2}`);
  // The chart: the shared chart, one bar per month to scale from zero, labelled, with the Autopilot mark in September.
  const svg=rendered.container.querySelector('[data-capacity-chart] svg[role="img"]')!;
  expect(svg.getAttribute('aria-label')).toBe('HR time freed by month: June 0 hours; July 0 hours; August 0 hours; September 14.5 hours; October 27 hours; November 38.5 hours. Autopilot started in September.');
  const bars=[...svg.querySelectorAll('rect')].map(rect=>Number(rect.getAttribute('height')));
  expect(bars).toHaveLength(6);
  const expected=[0,0,0,14.5,27,38.5];
  for(let i=0;i<6;i++)expect(bars[i]/bars[5]).toBeCloseTo(expected[i]/38.5,6);
  expect([...svg.querySelectorAll('text')].map(text)).toEqual(expect.arrayContaining(['14.5','27','38.5','Jun','Nov','Autopilot started']));
  const marker=svg.querySelector('[data-chart-marker] line')!;
  const septemberBar=[...svg.querySelectorAll('rect')][3];
  expect(Number(marker.getAttribute('x1'))).toBeLessThanOrEqual(Number(septemberBar.getAttribute('x')));
  // Where the time came from: manual time each = manual minutes / items with a baseline.
  const table=rendered.container.querySelector('[data-capacity-table] table')!;
  expect([...table.querySelectorAll('thead th')].map(text)).toEqual(['Loop or assistant work','Done','Your manual time each','Review time','Hours freed']);
  expect([...table.querySelectorAll('tbody tr')].map(row=>[...row.querySelectorAll('th,td')].map(parts))).toEqual([
   ['Payroll inputs ready','3','4 h','1 h','11'],
   ['Employee questions answered','212','3 min','0 h','10.6'],
   ['Missed clock-outs','612','1 min','0.7 h','9.5'],
   // 50 done, 2 of them without a baseline: 480 / 48 = 10 minutes each.
   ['Missing employee data 2 done where the baseline has no minutes for them','50','10 min','0.6 h','7.4']]);
  expect(text(rendered.container)).toContain('How it\'s measured: hours freed = work done × your own manual time per item (measured from the event log before Autopilot) − the time people spent reviewing. Nothing is estimated from industry averages.');
  const method=rendered.container.querySelector('details[data-capacity-method]')!;
  expect(text(method.querySelector('summary'))).toBe('Full method');
  expect(text(method)).toContain('up to 15 minutes and never more than the item\'s own manual time');
  expect(text(method)).toContain('A working day is 8 hours.');
  expect(text(method)).toContain('only group administrators may read across people');
  // 44px targets on a coarse pointer for every link, button and field.
  for(const el of rendered.container.querySelectorAll('[data-capacity-ledger] a,[data-capacity-ledger] button,[data-capacity-ledger] select,[data-capacity-ledger] summary'))
   expect(el.className,el.outerHTML.slice(0,80)).toContain('pointer-coarse:min-h-11');
 });

 it('without any baseline: "Baseline not set", with a guided way to set each company\'s',async()=>{
  state.view=view({},{freedMinutes:null,companiesWithoutBaseline:[C1,C2],months:MONTHS.map(([month])=>({month,freedMinutes:0})),
   rows:[{item:'loop_missed_clock_outs',done:612,manualMinutes:0,reviewMinutes:0,freedMinutes:0,withoutBaseline:612}]});
  const rendered=wrap('en',await section());
  const missing=rendered.container.querySelector('[data-baseline-missing]')!;
  expect(within(missing as HTMLElement).getByRole('heading',{level:3,name:'Baseline not set'})).toBeTruthy();
  expect(text(missing)).toContain('Hours freed are measured against your own manual time before Autopilot started.');
  expect(within(missing as HTMLElement).getAllByRole('link').map(link=>[text(link),link.getAttribute('href')])).toEqual([
   ['Set the baseline for Fictional Alpha Sdn Bhd',`/assistant?view=insights&period=last30&setup=${C1}`],
   ['Set the baseline for Fictional Beta Sdn Bhd',`/assistant?view=insights&period=last30&setup=${C2}`]]);
  const tile=rendered.container.querySelector('[data-stat-cells] > div')!;
  expect(parts(tile.querySelector('dd')!)).toBe('Baseline not set Set a baseline to measure it');
  expect([...rendered.container.querySelectorAll('[data-capacity-table] tbody tr')].map(row=>[...row.querySelectorAll('th,td')].map(parts))).toEqual([
   ['Missed clock-outs 612 done where the baseline has no minutes for them','612','Not in the baseline','0 h','0']]);
 });

 it('the guided set-up: the period ending when Autopilot started, what the event log measured, and the minutes',async()=>{
  state.view=view();state.setup=SETUP;
  const rendered=wrap('en',await section({setup:C2,days:'90'}));
  expect(state.reads).toContainEqual(['setup',{companyId:C2,days:'90'}]);
  const card=rendered.container.querySelector(`[data-baseline-setup="${C2}"]`)!;
  expect(within(card as HTMLElement).getByRole('heading',{level:3,name:'Baseline for Fictional Beta Sdn Bhd'})).toBeTruthy();
  expect(text(card)).toContain(`It ends on ${medium('2026-09-14')}, the day Autopilot started here.`);
  // period_to is exclusive: the last day is 13 September.
  expect(text(card.querySelector('[data-baseline-period]'))).toBe(`Period: ${medium('2026-06-16')} to ${medium('2026-09-13')}.`);
  expect(text(card.querySelector('[data-baseline-evidence="attendance_correction"]'))).toBe('Attendance corrections (missed clock-outs): 40 cases started, 36 completed, 52 staff actions (1.3 per case).');
  expect(text(card.querySelector('[data-baseline-evidence="profile_change"]'))).toBe('Profile changes (missing employee data): Not enough history to measure: 3 completed cases, at least 10 needed. Enter your minutes for it below.');
  const forms=[...card.querySelectorAll('form')];
  expect(forms[0].getAttribute('method')).toBe('get');
  expect([...forms[0].querySelectorAll('select[name="days"] option')].map(text)).toEqual(['30 days','90 days','180 days']);
  const save=forms[1];
  expect([...save.querySelectorAll('input')].map(input=>input.getAttribute('name'))).toEqual(['company','days','minutesPerStaffAction',
   'minutes.loop_payroll_inputs','minutes.loop_missed_clock_outs','minutes.loop_missing_employee_data','minutes.loop_probation_ending','minutes.loop_document_expiry',
   'minutes.questions_answered','minutes.actions_confirmed']);
  expect(save.querySelector('input[name="company"]')).toHaveAttribute('value',C2);
  expect(within(save as HTMLElement).getByRole('button',{name:'Save the baseline'})).toBeTruthy();
  for(const el of card.querySelectorAll('a,button,select,input:not([type="hidden"])'))expect(el.className).toContain('pointer-coarse:min-h-11');
 });

 it('marks the figures a company administrator may not read as not shown, never as zero',async()=>{
  state.view=view({companies:[COMPANIES[0]],companyId:C1},{questions:null,payrollErrors:null,companiesWithoutBaseline:[],
   rows:ledger().rows.filter(row=>row.item!=='questions_answered')});
  const rendered=wrap('en',await section({company:C1},SESSIONS.hrAdmin));
  expect(text(rendered.container)).toContain('What AI Centre did for the HR team of Fictional Alpha Sdn Bhd, measured against its own baseline.');
  expect(rendered.container.querySelector('[data-capacity-company-filter]')).toBeNull();
  const cells=[...rendered.container.querySelectorAll('[data-stat-cells] > div')].map(cell=>parts(cell.querySelector('dd')!));
  expect(cells[1]).toBe('Not shown Payroll is not in use');
  expect(cells[3]).toBe('Not shown Shown to group administrators');
  expect(rendered.container.querySelector('[data-capacity-row="questions_answered"]')).toBeNull();
 });

 it.each(LOCALES)('%s: renders with no missing message, says AI Centre, never Noveri, and shows no HR-staff ratio',async locale=>{
  state.locale=locale;state.view=view();state.setup=SETUP;
  const rendered=wrap(locale,await section({setup:C2,days:'90'}));
  const copy=messagesFor(locale).aiCentre.capacity;
  expect(screen.getByRole('heading',{level:2,name:copy.title})).toBeTruthy();
  const all=text(rendered.container)+' '+[...rendered.container.querySelectorAll('[aria-label]')].map(el=>el.getAttribute('aria-label')).join(' ');
  expect(all).toContain('AI Centre');
  expect(all).not.toMatch(/noveri/i);
  for(const pattern of RATIO)expect(all,String(pattern)).not.toMatch(pattern);
 });
});

describe('owner rule: no "HR staff per 100 employees" ratio anywhere',()=>{
 it('is absent from every catalogue, and the capacity strings carry no ratio in any language',()=>{
  const dir=path.join(__dirname,'..','messages');
  const files=[...fs.readdirSync(dir).filter(file=>file.endsWith('.json')).map(file=>path.join(dir,file)),
   ...fs.readdirSync(path.join(dir,'ai-centre')).filter(file=>file.endsWith('.json')).map(file=>path.join(dir,'ai-centre',file))];
  expect(files).toHaveLength(12);
  for(const file of files){
   const raw=fs.readFileSync(file,'utf8');
   expect(raw,file).not.toMatch(/(HR|staff|employees?)\s+(staff\s+)?per\s+100/i);
   expect(raw,file).not.toMatch(/per\s+100\s+employees/i);
  }
  for(const locale of LOCALES){
   const capacity=JSON.stringify(messagesFor(locale).aiCentre.capacity);
   expect(capacity.length).toBeGreaterThan(2000);
   expect(capacity,locale).not.toMatch(/100/);
   for(const pattern of RATIO)expect(capacity,`${locale} ${pattern}`).not.toMatch(pattern);
  }
 });
});
