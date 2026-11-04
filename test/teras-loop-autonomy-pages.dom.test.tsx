/** @vitest-environment jsdom */
/** AI v2 Phase 2 P2-1 — the autonomy ladder on screen, per role, from fictional reads (core/loops/views.ts and
 * core/loops/autonomy-views.ts are replaced by fixtures; the real services are covered by test/teras-loop-autonomy.test.ts).
 *
 *  - A loop's page at Level 2 in one company: the level badges, the level in each company with "Limits and levels",
 *    the recent actions with Undo only where the viewer may undo, "Limits it can never cross" with the company's own
 *    limits, and "Who answers for it", suspended when the sponsor lost access. A capped loop says it stays at Prepare
 *    and offers no promotion.
 *  - The promote page: the four levels with where the loop stands, the evidence table with each criterion, a sample of
 *    recent cards, the limits form with the fixed rows, and Promote only for a group administrator; read-only for an HR
 *    administrator of the company; Promote disabled with the reason while a requirement is unmet.
 *  - Today: the employee's "clock-out set" card with Undo, and HR's "moved down" card with the corrections.
 * An employee or a manager is refused before any read. Every locale renders with no missing message, says AI Centre
 * and never Noveri, and every control keeps a 44px target on a coarse pointer. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
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
const messagesFor=(locale:Locale)=>withAiCentre(locale,CATALOGUES[locale] as Record<string,unknown>) as typeof en & {aiCentre:Record<string,any>;today:Record<string,any>};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'ta'|'th',session:null as unknown,reads:[] as string[],canChange:false,certificateMet:true,
 sponsorLost:false,undo:{posts:[] as unknown[],result:{kind:'undone',by:'employee'} as unknown},levelA:2,conditionA:'roster_end',promoteLevel:1,promoteUndo:3,
 summaries:{} as Record<string,unknown>}));
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
vi.mock('../app/control-tower/loops/autonomy-actions',()=>({setLoopLevelAction:vi.fn(),undoLoopActionFromDetailAction:vi.fn(),changeLoopLimitsAction:vi.fn(),reviewLoopSampleAction:vi.fn()}));
vi.mock('../app/assistant/loop-clock-out-actions',()=>({confirmMissedClockOutAction:vi.fn()}));
vi.mock('../app/assistant/payroll-readiness-actions',()=>({answerTp3PreviousEmployerAction:vi.fn()}));
vi.mock('../app/assistant/loop-undo-actions',()=>({undoOwnLoopAction:async(input:unknown)=>{state.undo.posts.push(input);return state.undo.result;}}));

const A='00000000-0000-4000-8000-0000000000c1',B='00000000-0000-4000-8000-0000000000c2';
const fx=vi.hoisted(()=>{
 class LoopViewRefused extends Error{constructor(readonly reason:string){super(reason);}}
 const FUTURE=new Date('2099-01-01T00:00:00Z'),PAST=new Date('2020-01-01T00:00:00Z');
 const row=(id:string)=>({id,level:'prepare',on:true,stopped:false,running:true,sponsor:{userId:'u-2',name:'Daniel Fictional'},
  lastRun:{at:new Date('2026-11-03T15:05:00Z'),status:'ran',capped:false},prepared:4,confirmed:1,changed:1,correctionRate:0.5,proposesValue:id==='loop_missed_clock_outs',openNow:2,waitingNow:1,pausedCompanies:0});
 const detail=(id:string)=>({row:row(id),canSwitch:false,windowDays:30,companies:[],runs:[],cases:[]});
 const company=(companyId:string,companyName:string,level:number,extra:Record<string,unknown>={})=>({companyId,companyName,level,limits:level>=2?{maxActionsPerNight:50,undoDays:3,condition:'roster_end'}:null,
  changedAt:level>=2?new Date('2026-10-01T02:00:00Z'):null,changedBy:level>=2?'administrator':null,changedByName:level>=2?'Aisyah Fictional':null,lastChange:level>=2?'promoted':null,
  conditionSetByName:level>=2?'Aisyah Fictional':null,conditionSetAt:level>=2?new Date('2026-10-01T02:00:00Z'):null,...extra});
 const action=(id:string,extra:Record<string,unknown>)=>({id,at:new Date('2026-11-03T15:04:00Z'),personName:'Siti Fictional',companyName:'Fictional A Sdn Bhd',state:'applied',reason:null,
  facts:{date:'2026-11-03',checkIn:'09:02',checkOut:'18:00'},undoUntil:FUTURE,undo:null,peopleChanged:false,canUndo:true,...extra});
 return {LoopViewRefused,FUTURE,PAST,row,detail,company,action};
});
vi.mock('../core/loops/views',()=>({LoopViewRefused:fx.LoopViewRefused,
 loopsOverview:async()=>({rows:['loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry'].map(fx.row),canSwitch:false,windowDays:30}),
 loopDetail:async(_s:unknown,id:string)=>{state.reads.push('detail:'+id);if(!['loop_missed_clock_outs','loop_probation_ending'].includes(id))throw new fx.LoopViewRefused('not_found');
  const out=fx.detail(id);if(state.sponsorLost)out.row.lastRun={...out.row.lastRun,status:'sponsor_lost'};return out;}}));
vi.mock('../core/loops/autonomy-views',()=>({
 loopLevelSummaries:async()=>state.summaries,
 loopAutonomyDetail:async(_s:unknown,id:string)=>{state.reads.push('autonomy:'+id);
  if(id==='loop_probation_ending')return {workerId:id,maxLevel:1,promotableTo:1,capped:true,hasActor:false,canChange:state.canChange,usesCondition:false,siteExitRecorded:false,windowDays:30,
   companies:[fx.company(A,'Fictional A Sdn Bhd',1),fx.company(B,'Fictional B Sdn Bhd',1)],actions:[],samples:[],figures:{applied:0,corrected:0,undoneByEmployee:0,correctedShare:null}};
  const levelA=state.levelA;
  return {workerId:id,maxLevel:3,promotableTo:3,capped:false,hasActor:true,canChange:state.canChange,usesCondition:true,siteExitRecorded:false,windowDays:30,
   companies:[fx.company(A,'Fictional A Sdn Bhd',levelA,{limits:{maxActionsPerNight:50,undoDays:3,condition:state.conditionA}}),fx.company(B,'Fictional B Sdn Bhd',1)],
   samples:levelA===3?[{companyId:A,companyName:'Fictional A Sdn Bhd',weekStart:'2026-11-02',total:12,actions:[fx.action('a1',{})],reviewed:null,canReview:true}]:[],
   actions:[
    fx.action('a1',{}),
    fx.action('a2',{personName:'Daniel Fictional',facts:{date:'2026-11-02',checkIn:'08:30',checkOut:'17:30'},undo:{by:'employee',at:new Date('2026-11-03T01:00:00Z')},canUndo:false}),
    fx.action('a3',{personName:'Mei Ling Fictional',state:'not_applied',reason:'condition_leave',facts:{date:'2026-11-02',checkIn:'09:00',checkOut:'18:00'},canUndo:false}),
    fx.action('a4',{personName:'Ravi Fictional',facts:{date:'2026-10-20',checkIn:'09:00',checkOut:'18:00'},undoUntil:fx.PAST,canUndo:false}),
   ],figures:{applied:200,corrected:1,undoneByEmployee:1,correctedShare:0.005}};},
 loopPromotion:async(_s:unknown,id:string,companyId:string)=>{state.reads.push(`promote:${id}:${companyId}`);
  if(!['loop_missed_clock_outs','loop_missing_employee_data'].includes(id)||companyId!==B)throw new fx.LoopViewRefused('not_found');
  const met=state.certificateMet,level=state.promoteLevel;
  return {workerId:id,companyId:B,companyName:'Fictional B Sdn Bhd',level,targetLevel:level+1,maxLevel:3,capped:false,hasActor:true,canChange:state.canChange,
   usesCondition:id==='loop_missed_clock_outs',siteExitRecorded:false,version:level>=2?4:null,conditionSetByName:level>=2?'Aisyah Fictional':null,conditionSetAt:level>=2?new Date('2026-10-01T02:00:00Z'):null,
   certificate:{targetLevel:2,met,criteria:[
    {id:'prepared',needed:200,actual:met?214:150,count:null,met},
    {id:'changed',needed:0.01,actual:1/200,count:1,met:true},
    {id:'rule_broken',needed:0,actual:0,count:null,met:true},
    {id:'days_at_level',needed:30,actual:34,count:null,met:true}]},
   evidence:{windowDays:30,since:new Date('2026-10-04T00:00:00Z'),currentLevel:1,prepared:met?214:150,asPrepared:199,changed:1,ruleBroken:0,daysAtLevel:34,levelSince:new Date('2026-09-30T00:00:00Z')},
   sample:[{id:'k1',at:new Date('2026-11-03T15:05:00Z'),personName:'Siti Fictional',state:'closed',closeReason:'done',resolution:'as_prepared',facts:{date:'2026-11-02',proposedCheckOut:'18:00'}},
    {id:'k2',at:new Date('2026-11-03T15:05:00Z'),personName:'Daniel Fictional',state:'closed',closeReason:'done',resolution:'changed',facts:{date:'2026-11-01',proposedCheckOut:'17:30'}}],
   limits:{maxActionsPerNight:50,undoDays:state.promoteUndo,condition:'roster_end'},limitsStored:level>=2};},
}));
import LoopPage from '../app/control-tower/loops/[loop]/page';
// AI Centre navigation (4 Nov 2026): the Loops list also reads the payroll loops' statuses (ai-centre-loops-payroll-list.dom.test.tsx).
vi.mock('../core/loops/payroll-cycle-views',()=>({payrollCycleOverview:async()=>null}));
import LoopsPage from '../app/control-tower/loops/page';
import {resolveServerTree} from './helpers/server-tree';
import PromoteLoopPage from '../app/control-tower/loops/[loop]/promote/page';
import {LoopCards} from '../components/today/loop-cards';

const TENANT='00000000-0000-4000-8000-0000000000a1';
const SESSIONS={
 employee:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000001',roles:['employee'],grants:[{role:'employee',companyId:A}]},
 manager:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000002',roles:['employee','manager'],grants:[{role:'manager',companyId:A}]},
 hrAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000003',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:B}]},
 groupAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000004',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
} as const;
const wrap=(locale:Locale,node:ReactNode)=>render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} onError={error=>{throw error;}} timeZone="Asia/Kuala_Lumpur">
 <main className="relative min-w-0"><div className="min-w-0">{node}</div></main></NextIntlClientProvider>);
const text=(el:Node|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const detail=(loop:string,query:Record<string,string>={})=>LoopPage({params:Promise.resolve({loop}),searchParams:Promise.resolve(query)});
const promote=(loop:string,query:Record<string,string>)=>PromoteLoopPage({params:Promise.resolve({loop}),searchParams:Promise.resolve(query)});
/** An element's text with its parts kept apart, as they read on screen. */
const parts=(el:Element|null|undefined):string=>el?[...el.childNodes].map(node=>node.nodeType===1?parts(node as Element):text(node)).filter(Boolean).join(' '):'';
const inputs=(form:Element)=>[...form.querySelectorAll('input[type=hidden]')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`);
afterEach(()=>{cleanup();Object.assign(state,{locale:'en',session:null,reads:[],canChange:false,certificateMet:true,sponsorLost:false,undo:{posts:[],result:{kind:'undone',by:'employee'}},
 levelA:2,conditionA:'roster_end',promoteLevel:1,promoteUndo:3,summaries:{}});});

describe('a loop\'s page with the autonomy ladder',()=>{
 it.each(['employee','manager'] as const)('%s is refused before any read',async role=>{
  state.session=SESSIONS[role];
  await expect(detail('loop_missed_clock_outs')).rejects.toMatchObject({url:'/'});
  await expect(promote('loop_missed_clock_outs',{company:B})).rejects.toMatchObject({url:'/'});
  expect(state.reads).toEqual([]);
 });

 it('shows the level per company, recent actions with Undo where allowed, the limits and who answers for it',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;
  const view=wrap('en',await detail('loop_missed_clock_outs'));
  expect(state.reads).toEqual(['detail:loop_missed_clock_outs','autonomy:loop_missed_clock_outs']);
  expect([...view.container.querySelectorAll('[data-page-header] [data-loop-level]')].map(text)).toEqual(['Act within limits · Fictional A Sdn Bhd','Prepare · 1 company']);
  expect([...view.container.querySelectorAll('[data-loop-autonomy-figures] > div')].map(item=>[...item.childNodes].map(text).join(' ')))
   .toEqual(['200 Fixes in 30 days','0.5% Corrected by people','1 Undone by the employee']);
  expect([...view.container.querySelectorAll('[data-loop-level-company]')].map(item=>[parts(item.querySelector('span')),text(item.querySelector('[data-loop-level]')),
   item.querySelector('a')?.getAttribute('href')])).toEqual([
   ['Fictional A Sdn Bhd Set by Aisyah Fictional on Oct 1, 2026','Level 2 · Act within limits',`/control-tower/loops/loop_missed_clock_outs/promote?company=${A}`],
   ['Fictional B Sdn Bhd','Level 1 · Prepare',`/control-tower/loops/loop_missed_clock_outs/promote?company=${B}`]]);
  const table=view.container.querySelector('[data-loop-actions]')!;
  expect([...table.querySelectorAll('thead th')].map(text)).toEqual(['When','Person','What happened','Status','Action']);
  expect([...table.querySelectorAll('tbody tr')].map(row=>[...row.querySelectorAll('td')].slice(1,4).map(parts))).toEqual([
   ['Siti Fictional Fictional A Sdn Bhd','Clock-out set to 18:00 (roster end) for Nov 3, 2026','Fixed · undo until Jan 1, 2099, 8:00 AM'],
   ['Daniel Fictional Fictional A Sdn Bhd','Clock-out set to 17:30 (roster end) for Nov 2, 2026','Undone by the employee'],
   ['Mei Ling Fictional Fictional A Sdn Bhd','Not changed for Nov 2, 2026: approved leave that day','Left for the person to confirm'],
   ['Ravi Fictional Fictional A Sdn Bhd','Clock-out set to 18:00 (roster end) for Oct 20, 2026','Fixed']]);
  // Undo only on the action the viewer may still undo, posting the loop and the action and nothing else.
  const forms=[...table.querySelectorAll('form')];
  expect(forms.map(inputs)).toEqual([['loop=loop_missed_clock_outs','action=a1']]);
  expect(forms[0].querySelector('button')?.getAttribute('aria-label')).toBe('Undo · Siti Fictional');
  expect([...view.container.querySelectorAll('[data-loop-limits] li')].map(text)).toEqual([
   'Acts only when a clock-in and a roster end time both exist','Never touches a day with approved leave','Never changes pay, rates or overtime',
   'Never creates overtime: a fix that would add overtime is not kept',
   'Fictional A Sdn Bhd: acts only when “Roster end, no approved leave and no other clocking that day” (chosen by Aisyah Fictional on Oct 1, 2026)',
   'Fictional A Sdn Bhd: at most 50 fixes a night, each can be undone for 3 days','Drops back to Prepare by itself if more than 1% are corrected in 7 days','It calls no AI model.']);
  expect(view.container.querySelector('[data-loop-cannot-act]')).toBeNull();
  expect(view.container.querySelector('[data-loop-sample]')).toBeNull();
  expect(text(view.container)).toContain('Sponsor: Daniel Fictional');
  expect(text(view.container)).toContain('Suspended automatically if the sponsor leaves or loses HR access.');
  expect(view.container.querySelector('[data-loop-suspended]')).toBeNull();
  for(const button of view.container.querySelectorAll('button'))expect(button.className).toContain('pointer-coarse:min-h-11');
  for(const link of view.container.querySelectorAll('[data-loop-level-company] a'))expect(link.className).toContain('pointer-coarse:min-h-11');
 });

 it('says the result of an undo, and shows the loop suspended when its sponsor lost access',async()=>{
  state.session=SESSIONS.hrAdmin;state.sponsorLost=true;
  let view=wrap('en',await detail('loop_missed_clock_outs',{autonomy:'undone'}));
  expect(text(view.container.querySelector('[data-loop-autonomy-notice="undone"]'))).toBe('Undone. The day is back as it was, and the person gets a card to confirm their time.');
  expect(text(view.container.querySelector('[data-loop-suspended]'))).toBe('Suspended: its sponsor no longer has HR access.');
  cleanup();
  view=wrap('en',await detail('loop_missed_clock_outs',{autonomy:'expired'}));
  expect(screen.getByRole('alert').textContent).toBe('The undo window has closed.');
  cleanup();
  // An unknown code is ignored, never echoed.
  view=wrap('en',await detail('loop_missed_clock_outs',{autonomy:'<script>'}));
  expect(view.container.querySelector('[data-loop-autonomy-notice]')).toBeNull();
 });

 it('a capped loop stays at Prepare in every company and offers no promotion',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;
  const view=wrap('en',await detail('loop_probation_ending'));
  expect(text(view.container.querySelector('[data-loop-autonomy-help]'))).toBe('Pay, employment status, system access, discipline and statutory filing stay at Prepare in every company: a person always decides.');
  expect(view.container.querySelectorAll('[data-loop-level-company] a')).toHaveLength(0);
  expect(view.container.querySelector('[data-loop-actions]')).toBeNull();
  expect([...view.container.querySelectorAll('[data-page-header] [data-loop-level]')].map(text)).toEqual(['Prepare · 2 companies']);
  expect([...view.container.querySelectorAll('[data-loop-limits] li')].map(text)).toContain('It changes no record: it prepares a card and a person confirms on the usual page.');
 });
});

describe('the promote page',()=>{
 it('a group administrator sees the levels, the evidence, a sample, the limits and Promote',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;
  const view=wrap('en',await promote('loop_missed_clock_outs',{company:B}));
  expect(screen.getByRole('heading',{level:1,name:'Let the missed clock-outs loop act within limits in Fictional B Sdn Bhd?'})).toBeTruthy();
  expect(text(view.container.querySelector('[data-page-header]'))).toContain('At the next level it fixes them itself inside the limits below, tells each person, and every fix can be undone.');
  expect([...view.container.querySelectorAll('[data-autonomy-ladder] li')].map(parts)).toEqual([
   'Level 0 Watch','Level 1 · now Prepare','Level 2 · proposed Act within limits','Level 3 · after 90 days at Level 2 Act and audit']);
  expect(view.container.querySelector('[data-autonomy-level="1"]')?.getAttribute('aria-current')).toBe('step');
  const evidence=view.container.querySelector('[data-autonomy-evidence]')!;
  expect([...evidence.querySelectorAll('thead th')].map(text)).toEqual(['Requirement','Needed','Actual','Met']);
  expect([...evidence.querySelectorAll('tbody tr')].map(row=>[...row.querySelectorAll('th,td')].map(text))).toEqual([
   ['Prepared fixes','200 or more','214','Yes'],['Changed by a person','Under 1%','0.5% (1)','Yes'],['Rule broken','None','None','Yes'],['Time at this level','30 days','34 days','Yes']]);
  expect([...view.container.querySelectorAll('[data-autonomy-sample] li')].map(parts)).toEqual([
   'Siti Fictional Clock-out at 18:00 proposed for Nov 2, 2026 Nov 3, 2026, 11:05 PM · Confirmed as prepared',
   'Daniel Fictional Clock-out at 17:30 proposed for Nov 1, 2026 Nov 3, 2026, 11:05 PM · Changed by the person']);
  expect(text(view.container)).toContain('See all 214 with their outcomes');
  const form=view.container.querySelector('form#autonomy-promote')!;
  expect(inputs(form)).toEqual(['loop=loop_missed_clock_outs',`company=${B}`,'toLevel=2','expectedLevel=1']);
  expect((form.querySelector('input[name=maxActionsPerNight]') as HTMLInputElement).value).toBe('50');
  expect([...form.querySelectorAll('select[name=undoDays] option')].map(option=>[option.getAttribute('value'),text(option)])).toEqual([['3','3 days'],['7','7 days']]);
  expect([...form.querySelectorAll('select[name=condition] option')].map(option=>[option.getAttribute('value'),text(option)])).toEqual([
   ['roster_and_site_exit','Roster end and site exit agree'],['roster_end','Roster end, no approved leave and no other clocking that day']]);
  // No site exit is recorded, so the roster-end condition is what is offered first, explained plainly.
  expect((form.querySelector('select[name=condition]') as HTMLSelectElement).value).toBe('roster_end');
  expect(text(form.querySelector('[data-autonomy-condition-note]'))).toBe('With the roster-end condition, the clock-out is set to the roster end, the employee is told and can undo it, and the fix never creates overtime.');
  expect(text(form.querySelector('[data-autonomy-site-exit-note]'))).toContain('No site exit is recorded here yet');
  expect([...view.container.querySelectorAll('dl div')].map(parts)).toEqual(['Tell each person Always (fixed)','Drop back to Prepare when Over 1% changed in 7 days (fixed)']);
  expect(text(view.container)).toContain('Pay, employment status, system access and discipline can never go above Prepare, in any company.');
  const submit=screen.getByRole('button',{name:'Promote to Level 2 in Fictional B Sdn Bhd'});
  expect(submit.getAttribute('form')).toBe('autonomy-promote');
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  // Moving down from Prepare is to Watch, by its own form.
  const down=screen.getByRole('button',{name:'Move down to Watch'}).closest('form')!;
  expect(inputs(down)).toEqual(['loop=loop_missed_clock_outs',`company=${B}`,'toLevel=0','expectedLevel=1']);
  expect(screen.getByRole('link',{name:'Not yet'})).toHaveAttribute('href','/control-tower/loops/loop_missed_clock_outs');
  expect(text(view.container)).toContain('Group administrators only. Recorded with your name; you can move it back at any time.');
  for(const control of view.container.querySelectorAll('button,select,input:not([type=hidden])'))expect(control.className).toContain('pointer-coarse:min-h-11');
 });

 it('keeps Promote disabled, with the reason, while a requirement is unmet',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;state.certificateMet=false;
  const view=wrap('en',await promote('loop_missed_clock_outs',{company:B}));
  expect(view.container.querySelector('[data-autonomy-criterion="prepared"]')?.getAttribute('data-met')).toBe('no');
  const submit=screen.getByRole('button',{name:'Promote to Level 2 in Fictional B Sdn Bhd'}) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(document.getElementById(submit.getAttribute('aria-describedby')!)?.textContent).toBe('Not every requirement is met yet, so it cannot be promoted.');
 });

 it('an HR administrator of the company reads it without any control',async()=>{
  state.session=SESSIONS.hrAdmin;state.canChange=false;
  const view=wrap('en',await promote('loop_missed_clock_outs',{company:B,error:'refused'}));
  expect(view.container.querySelectorAll('form')).toHaveLength(0);
  expect(view.container.querySelectorAll('[data-autonomy-commands] button')).toHaveLength(0);
  expect(text(view.container)).toContain('Only a group administrator can change a loop\'s level.');
  expect([...view.container.querySelectorAll('dl div')].map(parts)).toEqual(['Most fixes per night 50','Employee can undo for 3 days',
   'Only fix when Roster end, no approved leave and no other clocking that day','Tell each person Always (fixed)','Drop back to Prepare when Over 1% changed in 7 days (fixed)']);
  expect(view.container.querySelector('select')).toBeNull();
 });

 it('a company the viewer does not administer, or a loop that does not exist, is not found',async()=>{
  state.session=SESSIONS.groupAdmin;
  await expect(promote('loop_missed_clock_outs',{company:A})).rejects.toMatchObject({notFound:true});
  await expect(promote('loop_invented',{company:B})).rejects.toMatchObject({notFound:true});
 });
});

const cards=[
  {kind:'autoFixed',actionId:'00000000-0000-4000-8000-00000000ac71',date:'2026-11-02',checkOut:'18:00',undoUntil:'2026-11-05T15:04:00.000Z'},
  {kind:'movedDown',changeId:'ch-1',workerId:'loop_missed_clock_outs',companyName:'Fictional A Sdn Bhd',at:'2026-11-03T15:05:00.000Z',applied:50,corrected:2,
   corrections:[{personName:'Daniel Fictional',date:'2026-11-02',kind:'undone',by:'employee'},{personName:null,date:'2026-11-01',kind:'changed',by:null}],more:0,
   href:'/control-tower/loops/loop_missed_clock_outs'},
] as const;
describe('Today: the ladder\'s cards',()=>{
 it('the employee undoes the fix on their own day, and HR sees the loop moved down with the corrections',async()=>{
  const view=wrap('en',<ul>{await LoopCards({cards:cards as never,locale:'en'})}</ul>);
  const fixed=view.container.querySelector('[data-today-loop="autoFixed"]')!;
  expect(text(fixed.querySelector('h3'))).toBe('Clock-out set to 18:00 for Mon, Nov 2');
  expect(text(fixed)).toContain('Your roster end');
  expect(text(fixed)).toContain('Done by AI Centre: Missed clock-outs');
  expect(text(fixed)).toContain('You can undo it until Nov 5, 2026, 11:04 PM');
  const undo=within(fixed as HTMLElement).getByRole('button',{name:'Undo · Clock-out set to 18:00 for Mon, Nov 2'});
  expect(undo.className).toContain('pointer-coarse:min-h-11');
  await act(async()=>{fireEvent.click(undo);});
  expect(state.undo.posts).toEqual([{actionId:'00000000-0000-4000-8000-00000000ac71',confirm:true}]);
  expect(text(fixed.querySelector('[data-auto-fix-outcome]'))).toBe('Undone. Your day is back as it was; confirm your clock-out on its card.');
  const moved=view.container.querySelector('[data-today-loop="movedDown"]')!;
  expect(text(moved.querySelector('h3'))).toBe('Missed clock-outs moved down to Prepare in Fictional A Sdn Bhd');
  expect([...moved.querySelectorAll('h3 + div span')].map(text)).toEqual(['2 of 50 fixes corrected by people in 7 days',
   'Daniel Fictional · Mon, Nov 2 · undone by the employee','Someone · Sun, Nov 1 · changed afterwards','It prepares cards again until a group administrator promotes it.']);
  expect(within(moved as HTMLElement).getByRole('link')).toHaveAttribute('href','/control-tower/loops/loop_missed_clock_outs');
 });

 it('a refused undo says why and keeps the card',async()=>{
  state.undo.result={kind:'refused',reason:'expired'};
  const view=wrap('en',<ul>{await LoopCards({cards:[cards[0]] as never,locale:'en'})}</ul>);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/^Undo/}));});
  expect(text(view.container.querySelector('[data-auto-fix-refusal]'))).toBe('The undo window has closed. Ask HR to change it.');
  expect(view.container.querySelector('[data-auto-fix-outcome]')).toBeNull();
 });
});

describe('round 2: limits, the condition, the sample and the overview',()=>{
 it('at Level 2 a group administrator makes the limits stricter or changes the condition, bounded by the limits in force',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;state.promoteLevel=2;state.promoteUndo=7;
  const view=wrap('en',await promote('loop_missed_clock_outs',{company:B}));
  const form=view.container.querySelector('form#autonomy-limits')!;
  expect(inputs(form)).toEqual(['loop=loop_missed_clock_outs',`company=${B}`,'expectedVersion=4']);
  expect((form.querySelector('input[name=maxActionsPerNight]') as HTMLInputElement).max).toBe('50');
  expect([...form.querySelectorAll('select[name=undoDays] option')].map(option=>option.getAttribute('value'))).toEqual(['7']);
  expect([...form.querySelectorAll('select[name=condition] option')].map(option=>option.getAttribute('value'))).toEqual(['roster_and_site_exit','roster_end']);
  expect(text(form)).toContain('Without a promotion the limits can only be made stricter');
  expect(text(form)).toContain('(chosen by Aisyah Fictional on Oct 1, 2026, 10:00 AM)');
  expect(screen.getByRole('button',{name:'Save the limits'}).className).toContain('pointer-coarse:min-h-11');
  // The Level 3 promotion has its own form.
  expect(inputs(view.container.querySelector('form#autonomy-promote')!)).toEqual(['loop=loop_missed_clock_outs',`company=${B}`,'toLevel=3','expectedLevel=2']);
 });
 it('an HR administrator of the company is never offered the condition or the limits',async()=>{
  state.session=SESSIONS.hrAdmin;state.promoteLevel=2;
  const view=wrap('en',await promote('loop_missed_clock_outs',{company:B}));
  expect(view.container.querySelectorAll('form,select')).toHaveLength(0);
  expect(text(view.container)).toContain('Roster end, no approved leave and no other clocking that day');
 });
 it('the missing employee data loop is promoted with request limits and no condition to choose',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;
  const view=wrap('en',await promote('loop_missing_employee_data',{company:B}));
  const form=view.container.querySelector('form#autonomy-promote')!;
  expect(inputs(form)).toEqual(['loop=loop_missing_employee_data',`company=${B}`,'toLevel=2','expectedLevel=1','condition=roster_end']);
  expect(form.querySelector('select[name=condition]')).toBeNull();
  expect(form.querySelector('[data-autonomy-condition-note]')).toBeNull();
  expect([...form.querySelectorAll('label > span')].map(text)).toEqual(['Most requests per night','HR can withdraw for']);
 });
 it('says plainly when the site-exit condition means the loop cannot act yet',async()=>{
  state.session=SESSIONS.groupAdmin;state.conditionA='roster_and_site_exit';
  const view=wrap('en',await detail('loop_missed_clock_outs'));
  expect(text(view.container.querySelector('[data-loop-cannot-act]'))).toBe('It cannot act yet: no site exit is recorded, so “roster end and site exit agree” cannot hold. It keeps preparing cards.');
 });
 it('at Level 3 the loop page shows the weekly sample HR reviews, with the way to record the review',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;state.levelA=3;
  const view=wrap('en',await detail('loop_missed_clock_outs'));
  const sample=view.container.querySelector(`[data-loop-sample="${A}"]`)!;
  expect(text(sample)).toContain('1 of 12 actions in the week of Nov 2, 2026');
  const form=sample.querySelector('form')!;
  expect(inputs(form)).toEqual(['loop=loop_missed_clock_outs',`company=${A}`,'week=2026-11-02']);
  expect(form.querySelector('button')?.getAttribute('aria-label')).toBe('Mark the sample reviewed · Fictional A Sdn Bhd');
  expect(sample.querySelectorAll('[data-loop-actions] tbody tr')).toHaveLength(1);
  expect(text(view.container)).toContain('At Act and audit, HR reviews a weekly sample instead of every action.');
 });
 it('the overview names the level in each company for each loop',async()=>{
  state.session=SESSIONS.groupAdmin;state.summaries={loop_missed_clock_outs:[{level:2,count:1},{level:1,count:4}],loop_probation_ending:[{level:1,count:5}]};
  const view=wrap('en',await resolveServerTree(await LoopsPage({searchParams:Promise.resolve({})})));
  const cell=(id:string)=>text(view.container.querySelector(`[data-loop-row="${id}"] [data-loop-level-summary]`));
  expect(cell('loop_missed_clock_outs')).toBe('Act within limits · 1 company · Prepare · 4 companies');
  expect(cell('loop_probation_ending')).toBe('Prepare');
  expect(cell('loop_payroll_inputs')).toBe('Prepare');
 });
 it('HR\'s Today shows each action at Level 2, the weekly sample at Level 3 and what the loop left for people',async()=>{
  const feed=[
   {kind:'acted',workerId:'loop_missed_clock_outs',companyId:A,companyName:'Fictional A Sdn Bhd',count:2,items:[{personName:'Siti Fictional',date:'2026-11-02',reason:null},{personName:null,date:'2026-11-01',reason:null}],more:0,href:'/control-tower/loops/loop_missed_clock_outs'},
   {kind:'sample',workerId:'loop_missed_clock_outs',companyId:B,companyName:'Fictional B Sdn Bhd',weekStart:'2026-11-02',size:5,total:12,href:'/control-tower/loops/loop_missed_clock_outs'},
   {kind:'leftAlone',workerId:'loop_missed_clock_outs',companyId:A,companyName:'Fictional A Sdn Bhd',count:1,items:[{personName:'Mei Ling Fictional',date:'2026-11-02',reason:'condition_leave'}],more:0,href:'/control-tower/loops/loop_missed_clock_outs'},
  ];
  const view=wrap('en',<ul>{await LoopCards({cards:feed as never,locale:'en'})}</ul>);
  const card=(kind:string)=>view.container.querySelector(`[data-today-loop="${kind}"]`)!;
  expect(text(card('acted').querySelector('h3'))).toBe('Missed clock-outs made 2 changes in Fictional A Sdn Bhd in the last day');
  expect([...card('acted').querySelectorAll('h3 + div span')].map(text)).toEqual(['Siti Fictional · Mon, Nov 2','Someone · Sun, Nov 1','At Act within limits every action shows here. Open the loop to undo one.']);
  expect(text(card('sample').querySelector('h3'))).toBe('Weekly sample to review: Missed clock-outs in Fictional B Sdn Bhd');
  expect(text(card('sample'))).toContain('5 of 12 actions this week');
  expect(text(card('leftAlone').querySelector('h3'))).toBe('Missed clock-outs left 1 item for people in Fictional A Sdn Bhd');
  expect(text(card('leftAlone'))).toContain('Mei Ling Fictional · Mon, Nov 2 · approved leave that day');
 });
});

describe('every locale',()=>{
 it.each(['ms','zh','vi','ta','th'] as const)('%s: the loop page, the promote page and the Today cards render translated, with no missing message, saying AI Centre and never Noveri',async locale=>{
  state.locale=locale;state.session=SESSIONS.groupAdmin;state.canChange=true;
  const copy=messagesFor(locale);
  let view=wrap(locale,await detail('loop_missed_clock_outs',{autonomy:'undone'}));
  expect(screen.getByRole('heading',{level:1,name:copy.aiCentre.loops.names.loop_missed_clock_outs})).toBeTruthy();
  expect(text(view.container)).toContain(copy.aiCentre.autonomy.limits.title);
  expect(text(view.container)).not.toMatch(/noveri/i);
  cleanup();
  view=wrap(locale,await promote('loop_missed_clock_outs',{company:B,saved:'promoted'}));
  expect(text(view.container)).toContain(copy.aiCentre.autonomy.promote.tellValue);
  expect(text(view.container)).not.toMatch(/noveri/i);
  cleanup();
  view=wrap(locale,<ul>{await LoopCards({cards:cards as never,locale})}</ul>);
  expect(text(view.container)).toContain(copy.today.autonomy.undo);
  expect(text(view.container)).not.toMatch(/noveri/i);
 });
});
