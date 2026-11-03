/** @vitest-environment jsdom */
/** AI v2 W8 — AI Centre › Operations › Loops and one loop's page, rendered per role from a fictional read
 * (core/loops/views.ts is replaced by a fixture; the real services are covered by test/teras-loops.test.ts).
 *
 * The guard is the existing requireAdmin: an employee or a manager is sent away before any read. An HR administrator
 * of one company sees every loop's state and figures but no switch; a group administrator also switches each loop.
 * Expected text is written out from the fixture through the real catalogues; every locale renders with no missing
 * message, says AI Centre and never Noveri, and every control keeps a 44px target on a coarse pointer. */
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
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'ta'|'th',session:null as unknown,reads:[] as string[],canSwitch:false}));
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
 usePathname:()=>'/control-tower/loops',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),
}));
vi.mock('../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>true,isModuleEnabledOrFalse:()=>true}));
vi.mock('../app/control-tower/loops/actions',()=>({setLoopSwitchAction:vi.fn(),setLoopPauseAction:vi.fn()}));
const fx=vi.hoisted(()=>{
 const row=(id:string,extra:Record<string,unknown>={})=>({id,level:'prepare',on:false,stopped:false,running:false,sponsor:null,lastRun:null,prepared:0,confirmed:0,changed:0,
  correctionRate:null,proposesValue:id==='loop_missed_clock_outs',openNow:0,waitingNow:0,pausedCompanies:0,...extra});
 const rows=()=>[
  row('loop_probation_ending',{on:true,running:true,sponsor:{userId:'u-1',name:'Aisyah Fictional'},lastRun:{at:new Date('2026-11-03T15:04:00Z'),status:'ran',capped:false},prepared:9,confirmed:8,openNow:1}),
  row('loop_payroll_inputs'),
  row('loop_missing_employee_data',{on:true,running:true,sponsor:{userId:'u-1',name:null},lastRun:{at:new Date('2026-11-03T15:04:00Z'),status:'sponsor_lost',capped:false},pausedCompanies:1}),
  row('loop_missed_clock_outs',{on:true,running:true,sponsor:{userId:'u-2',name:'Daniel Fictional'},lastRun:{at:new Date('2026-11-03T15:05:00Z'),status:'ran',capped:false},prepared:4,confirmed:1,changed:1,correctionRate:0.5,waitingNow:1,openNow:2}),
  row('loop_document_expiry'),
 ];
 class LoopViewRefused extends Error{constructor(readonly reason:string){super(reason);}}
 return {rows,LoopViewRefused};
});
vi.mock('../core/loops/views',()=>({LoopViewRefused:fx.LoopViewRefused,
 loopsOverview:async()=>{state.reads.push('overview');return {rows:fx.rows(),canSwitch:state.canSwitch,windowDays:30};},
 loopDetail:async(_s:unknown,id:string)=>{state.reads.push('detail:'+id);if(id!=='loop_missed_clock_outs')throw new fx.LoopViewRefused('not_found');
  return {row:fx.rows()[3],canSwitch:state.canSwitch,windowDays:30,
   companies:[{companyId:'00000000-0000-4000-8000-0000000000c1',companyName:'Fictional A Sdn Bhd',paused:false},{companyId:'00000000-0000-4000-8000-0000000000c2',companyName:'Fictional B Sdn Bhd',paused:true}],
   runs:[{at:new Date('2026-11-03T15:05:00Z'),companyName:'Fictional A Sdn Bhd',status:'ran',observed:3,opened:1,reopened:0,closed:2,openNow:2,waitingNow:1,capped:false}],
   cases:[
    {id:'k1',openedAt:new Date('2026-11-02T15:04:00Z'),closedAt:new Date('2026-11-03T15:05:00Z'),personName:'Siti Fictional',companyName:'Fictional A Sdn Bhd',state:'closed',closeReason:'done',resolution:'as_prepared',reopenCount:0,facts:{date:'2026-11-02',proposedCheckOut:'18:00'}},
    {id:'k2',openedAt:new Date('2026-11-03T15:05:00Z'),closedAt:null,personName:'Ravi Fictional',companyName:'Fictional A Sdn Bhd',state:'waiting',closeReason:null,resolution:null,reopenCount:1,facts:{date:'2026-11-03',proposedCheckOut:'17:30'}},
   ]};}}));
import LoopsPage from '../app/control-tower/loops/page';
import LoopPage from '../app/control-tower/loops/[loop]/page';

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
/** A cell's or tile's text with its parts kept apart, as they read on screen. */
const parts=(el:Element)=>[...el.childNodes].map(node=>text(node)).filter(Boolean).join(' ');
const list=async()=>LoopsPage({searchParams:Promise.resolve({})});
const detail=async(loop:string,query:Record<string,string>={})=>LoopPage({params:Promise.resolve({loop}),searchParams:Promise.resolve(query)});
afterEach(()=>{cleanup();state.locale='en';state.session=null;state.reads=[];state.canSwitch=false;});

describe('Operations › Loops, per role',()=>{
 it.each(['employee','manager'] as const)('%s is refused before any read',async role=>{
  state.session=SESSIONS[role];
  await expect(list()).rejects.toMatchObject({url:'/'});
  await expect(detail('loop_missed_clock_outs')).rejects.toMatchObject({url:'/'});
  expect(state.reads).toEqual([]);
 });

 it('an HR administrator sees each loop at Prepare with its figures and sponsor, and no switch',async()=>{
  state.session=SESSIONS.hrAdmin;
  const view=wrap('en',await list());
  expect(state.reads).toEqual(['overview']);
  const second=screen.getByRole('navigation',{name:'Operations sections'});
  expect(within(second).getByRole('link',{current:'page'})).toHaveAttribute('href','/control-tower/loops');
  expect(screen.getByRole('heading',{level:1,name:'Loops'})).toBeTruthy();
  const table=view.container.querySelector('[data-loops-table]')!;
  expect([...table.querySelectorAll('thead th')].map(text)).toEqual(['Loop','Done means','Level','Switch','Last run','Cards, last 30 days','Completed as prepared','Changed by a person','Sponsor']);
  const rows=[...table.querySelectorAll('tbody tr')].map(row=>[...row.querySelectorAll('th,td')].map(parts));
  expect(rows).toEqual([
   ['Probation ending','A decision is recorded before the probation ends','Prepare','On','Nov 3, 2026, 11:04 PM','9','8','Not applicable','Aisyah Fictional'],
   ['Payroll inputs ready','Nothing blocks the payroll run before the cut-off','Prepare','Off','Not run yet','0','0','Not applicable','None while off'],
   ['Missing employee data Paused in 1 company','Every detail the employee can fill in is filled in and approved','Prepare','On','Nov 3, 2026, 11:04 PM Stopped: its sponsor no longer has administrator access','0','0','Not applicable','An administrator'],
   ['Missed clock-outs','Every clock-out is on record','Prepare','On','Nov 3, 2026, 11:05 PM','4','1','50% (1 card)','Daniel Fictional'],
   ['Passports expiring','Each passport is renewed before it expires','Prepare','Off','Not run yet','0','0','Not applicable','None while off'],
  ]);
  expect(table.querySelector('a[href="/control-tower/loops/loop_missed_clock_outs"]')).not.toBeNull();
  expect(table.querySelectorAll('button,form')).toHaveLength(0);
  expect(text(view.container)).toContain('Only a group administrator switches loops on or off.');
  expect(text(view.container)).toContain('Pay, employment status, system access and discipline stay at Prepare: a person always decides.');
 });

 it('a group administrator also switches each loop, with a 44px target on a coarse pointer',async()=>{
  state.session=SESSIONS.groupAdmin;state.canSwitch=true;
  const view=wrap('en',await list());
  const buttons=[...view.container.querySelectorAll('[data-loops-table] button')];
  expect(buttons.map(button=>button.getAttribute('aria-label'))).toEqual(['Turn off · Probation ending','Turn on · Payroll inputs ready','Turn off · Missing employee data',
   'Turn off · Missed clock-outs','Turn on · Passports expiring']);
  for(const button of buttons)expect(button.className).toContain('pointer-coarse:min-h-11');
  for(const link of view.container.querySelectorAll('[data-loops-table] a'))expect(link.className).toContain('pointer-coarse:min-h-11');
  const forms=[...view.container.querySelectorAll('[data-loops-table] form')];
  expect(forms.map(form=>[...form.querySelectorAll('input')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`))).toEqual([
   ['loop=loop_probation_ending','enabled=false'],['loop=loop_payroll_inputs','enabled=true'],['loop=loop_missing_employee_data','enabled=false'],
   ['loop=loop_missed_clock_outs','enabled=false'],['loop=loop_document_expiry','enabled=true']]);
  expect(text(view.container)).toContain('whoever switches it on becomes its sponsor');
 });

 it('one loop\'s page: steps, figures, a pause per company, recent cards and runs, and who answers for it',async()=>{
  state.session=SESSIONS.hrAdmin;
  const view=wrap('en',await detail('loop_missed_clock_outs'));
  expect(screen.getByRole('heading',{level:1,name:'Missed clock-outs'})).toBeTruthy();
  expect(text(view.container.querySelector('[data-page-header]'))).toContain('Done means: Every clock-out is on record.');
  expect([...view.container.querySelectorAll('[data-loop-steps] li')].map(parts)).toEqual([
   '1 · Detect A day in the last 7 days with a clock-in and no clock-out.',
   '2 · Diagnose The roster end time for that day, which the card proposes.',
   '3 · Prepare A correction card for the employee, who confirms the time or changes it. Their approver decides as usual.',
   '4 · Verify Closed when a clock-out is on record. A rejected correction reopens it.']);
  expect([...view.container.querySelectorAll('[data-loop-figures] > div')].map(parts)).toEqual(['4 Cards prepared in 30 days','1 Completed as prepared','50% Changed by people','2 open · 1 waiting Open now']);
  expect([...view.container.querySelectorAll('[data-loop-company]')].map(item=>[text(item.querySelector('span')),item.querySelector('button')?.getAttribute('aria-label')])).toEqual([
   ['Fictional A Sdn Bhd','Pause · Fictional A Sdn Bhd'],['Fictional B Sdn Bhd','Resume · Fictional B Sdn Bhd']]);
  expect([...view.container.querySelectorAll('[data-loop-cases] tbody tr')].map(row=>[...row.querySelectorAll('td')].slice(1).map(parts))).toEqual([
   ['Siti Fictional Fictional A Sdn Bhd','Clock-out at 18:00 proposed for Nov 2, 2026','Confirmed as prepared'],
   ['Ravi Fictional Fictional A Sdn Bhd','Clock-out at 17:30 proposed for Nov 3, 2026 Reopened once','Sent: waiting for the usual approval']]);
  expect(text(view.container)).toContain('Sponsor: Daniel Fictional');
  expect(text(view.container)).toContain('It calls no AI model.');
  expect(text(view.container)).toContain('No AI spend: these loops use rules only, never a model.');
  // No loop switch for a company administrator; the pause buttons keep 44px targets.
  expect(view.container.querySelector('[data-page-header] form')).toBeNull();
  for(const button of view.container.querySelectorAll('button'))expect(button.className).toContain('pointer-coarse:min-h-11');
 });

 it('an unknown loop is not found',async()=>{
  state.session=SESSIONS.groupAdmin;
  await expect(detail('loop_invented')).rejects.toMatchObject({notFound:true});
 });

 it.each(['ms','zh','vi','ta','th'] as const)('%s: both pages render translated, with no missing message, saying AI Centre and never Noveri',async locale=>{
  state.locale=locale;state.session=SESSIONS.groupAdmin;state.canSwitch=true;
  const copy=messagesFor(locale);
  let view=wrap(locale,await list());
  expect(screen.getByRole('heading',{level:1,name:copy.aiCentre.loops.title})).toBeTruthy();
  expect(view.container.querySelectorAll('[data-loops-table] tbody tr')).toHaveLength(5);
  expect(text(view.container)).not.toMatch(/noveri/i);
  cleanup();
  view=wrap(locale,await detail('loop_missed_clock_outs',{saved:'pause'}));
  expect(screen.getByRole('heading',{level:1,name:copy.aiCentre.loops.names.loop_missed_clock_outs})).toBeTruthy();
  expect(text(view.container)).not.toMatch(/noveri/i);
 });
});
