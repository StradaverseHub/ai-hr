/** @vitest-environment jsdom */
/** Fictional authorised view fixtures test the operational pages. Missed clock-outs are
 * Observe/Prepare only; stored Act levels are projected down by the read owner, while historical
 * action records remain reviewable without automatic Undo. Missing employee data deliberately
 * retains its Act/Act-and-audit controls. Core authorization/capping is tested separately. */
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
  facts:{date:'2026-11-03',checkIn:'09:02',checkOut:'18:00',gaps:3},undoUntil:FUTURE,undo:null,peopleChanged:false,canUndo:true,...extra});
 return {LoopViewRefused,FUTURE,PAST,row,detail,company,action};
});
vi.mock('../core/loops/views',()=>({LoopViewRefused:fx.LoopViewRefused,
 loopsOverview:async()=>({rows:['loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry'].map(fx.row),canSwitch:false,windowDays:30}),
 loopDetail:async(_s:unknown,id:string)=>{state.reads.push('detail:'+id);if(!['loop_missed_clock_outs','loop_probation_ending','loop_missing_employee_data'].includes(id))throw new fx.LoopViewRefused('not_found');
  const out=fx.detail(id);if(state.sponsorLost)out.row.lastRun={...out.row.lastRun,status:'sponsor_lost'};return out;}}));
vi.mock('../core/loops/autonomy-views',()=>({
 // Fixtures represent the reader's effective projection, not its obsolete stored configuration.
 loopLevelSummaries:async()=>Object.fromEntries(Object.entries(state.summaries).map(([id,raw])=>{
  if(id!=='loop_missed_clock_outs')return[id,raw];
  const counts=new Map<number,number>();for(const row of raw as {level:number;count:number}[]){const level=Math.min(row.level,1);counts.set(level,(counts.get(level)??0)+row.count);}
  return[id,[...counts].sort((a,b)=>b[0]-a[0]).map(([level,count])=>({level,count}))];
 })),
 loopAutonomyDetail:async(_s:unknown,id:string)=>{state.reads.push('autonomy:'+id);
  if(id==='loop_probation_ending')return {workerId:id,maxLevel:1,promotableTo:1,capped:true,hasActor:false,canChange:state.canChange,usesCondition:false,siteExitRecorded:false,windowDays:30,
   companies:[fx.company(A,'Fictional A Sdn Bhd',1),fx.company(B,'Fictional B Sdn Bhd',1)],actions:[],samples:[],figures:{applied:0,corrected:0,undoneByEmployee:0,correctedShare:null}};
  const missed=id==='loop_missed_clock_outs',levelA=missed?Math.min(state.levelA,1):state.levelA;
  return {workerId:id,maxLevel:missed?1:3,promotableTo:missed?1:3,capped:missed,hasActor:!missed,canChange:state.canChange,usesCondition:missed,siteExitRecorded:false,windowDays:30,
   companies:[fx.company(A,'Fictional A Sdn Bhd',state.levelA,{level:levelA,limits:{maxActionsPerNight:50,undoDays:3,condition:state.conditionA}}),fx.company(B,'Fictional B Sdn Bhd',1)],
   samples:!missed&&levelA===3?[{companyId:A,companyName:'Fictional A Sdn Bhd',weekStart:'2026-11-02',total:12,actions:[fx.action('a1',{})],reviewed:null,canReview:true}]:[],
   actions:[
    fx.action('a1',missed?{reviewHref:'/attendance/individual/2026-11-03?emp=fictional-person'}:{}),
    fx.action('a2',{personName:'Daniel Fictional',facts:{date:'2026-11-02',checkIn:'08:30',checkOut:'17:30'},undo:{by:'employee',at:new Date('2026-11-03T01:00:00Z')},canUndo:false}),
    fx.action('a3',{personName:'Mei Ling Fictional',state:'not_applied',reason:'condition_leave',facts:{date:'2026-11-02',checkIn:'09:00',checkOut:'18:00'},canUndo:false}),
    fx.action('a4',{personName:'Ravi Fictional',facts:{date:'2026-10-20',checkIn:'09:00',checkOut:'18:00'},undoUntil:fx.PAST,canUndo:false}),
   ],figures:{applied:200,corrected:1,undoneByEmployee:1,correctedShare:0.005}};},
 loopPromotion:async(_s:unknown,id:string,companyId:string)=>{state.reads.push(`promote:${id}:${companyId}`);
  if(!['loop_missed_clock_outs','loop_missing_employee_data'].includes(id)||companyId!==B)throw new fx.LoopViewRefused('not_found');
  const missed=id==='loop_missed_clock_outs',met=state.certificateMet,level=missed?Math.min(state.promoteLevel,1):state.promoteLevel;
  return {workerId:id,companyId:B,companyName:'Fictional B Sdn Bhd',level,targetLevel:missed?(level===0?1:null):level+1,maxLevel:missed?1:3,capped:missed,hasActor:!missed,canChange:state.canChange,
   usesCondition:id==='loop_missed_clock_outs',siteExitRecorded:false,version:state.promoteLevel>=2?4:null,conditionSetByName:state.promoteLevel>=2?'Aisyah Fictional':null,conditionSetAt:state.promoteLevel>=2?new Date('2026-10-01T02:00:00Z'):null,
   certificate:missed?null:{targetLevel:2,met,criteria:[
    {id:'prepared',needed:200,actual:met?214:150,count:null,met},
    {id:'changed',needed:0.01,actual:1/200,count:1,met:true},
    {id:'rule_broken',needed:0,actual:0,count:null,met:true},
    {id:'days_at_level',needed:30,actual:34,count:null,met:true}]},
   evidence:{windowDays:30,since:new Date('2026-10-04T00:00:00Z'),currentLevel:level,prepared:met?214:150,asPrepared:199,changed:1,ruleBroken:0,daysAtLevel:34,levelSince:new Date('2026-09-30T00:00:00Z')},
   sample:[{id:'k1',at:new Date('2026-11-03T15:05:00Z'),personName:'Siti Fictional',state:'closed',closeReason:'done',resolution:'as_prepared',facts:{date:'2026-11-02',proposedCheckOut:'18:00'}},
    {id:'k2',at:new Date('2026-11-03T15:05:00Z'),personName:'Daniel Fictional',state:'closed',closeReason:'done',resolution:'changed',facts:{date:'2026-11-01',proposedCheckOut:'17:30'}}],
   limits:{maxActionsPerNight:50,undoDays:state.promoteUndo,condition:'roster_end'},limitsStored:state.promoteLevel>=2};},
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

describe('loop pages preserve review-only attendance and the remaining acting loop',()=>{
 it.each(['employee','manager'] as const)('%s is refused before any read',async role=>{
  state.session=SESSIONS[role];
  await expect(detail('loop_missed_clock_outs')).rejects.toMatchObject({url:'/'});
  await expect(promote('loop_missed_clock_outs',{company:B})).rejects.toMatchObject({url:'/'});
  expect(state.reads).toEqual([]);
 });
 it.each([2,3])('projects stale missed-clockout Level %s to Prepare while retaining historical actions',async storedLevel=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;state.levelA=storedLevel;
  const view=wrap('en',await detail('loop_missed_clock_outs'));
  expect(state.reads).toEqual(['detail:loop_missed_clock_outs','autonomy:loop_missed_clock_outs']);
  expect([...view.container.querySelectorAll('[data-page-header] [data-loop-level]')].map(text)).toEqual(['Prepare · 2 companies']);
  expect([...view.container.querySelectorAll('[data-loop-level-company] [data-loop-level]')].map(text)).toEqual(['Level 1 · Prepare','Level 1 · Prepare']);
  expect(view.container.querySelectorAll('[data-loop-level-company] a')).toHaveLength(0);
  expect(text(view.container.querySelector('[data-loop-autonomy-help]'))).toBe(messagesFor('en').aiCentre.autonomy.clockOutReviewOnly);
  expect([...view.container.querySelectorAll('[data-loop-autonomy-figures] > div')].map(item=>[...item.childNodes].map(text).join(' ')))
   .toEqual(['200 Fixes in 30 days','0.5% Corrected by people','1 Undone by the employee']);
  const table=view.container.querySelector('[data-loop-actions]')!;
  expect(table.querySelectorAll('tbody tr')).toHaveLength(4);
  expect(text(table)).toContain('Clock-out set to 18:00 (roster end) for Nov 3, 2026');
  expect(text(table)).toContain('Undone by the employee');
  expect(text(table)).toContain(messagesFor('en').aiCentre.autonomy.reviewRequiredStatus);
  expect(text(table)).not.toContain('undo until');
  // a1 intentionally retains obsolete canUndo:true in the fixture: the missed-clockout UI
  // itself must suppress Undo while retaining an authorised manual-correction destination.
  expect(table.querySelectorAll('form')).toHaveLength(0);
  expect(within(table as HTMLElement).queryByRole('button',{name:/^Undo/})).toBeNull();
  expect(within(table as HTMLElement).getByRole('link',{name:'Review correction'})).toHaveAttribute('href','/attendance/individual/2026-11-03?emp=fictional-person');
  expect(view.container.querySelector('[data-loop-sample]')).toBeNull();
  expect(view.container.querySelector('[data-loop-cannot-act]')).toBeNull();
  expect([...view.container.querySelectorAll('[data-loop-limits] li')].map(text)).toContain('It changes no record: it prepares a card and a person confirms on the usual page.');
  expect(text(view.container)).toContain('Sponsor: Daniel Fictional');
 });
 it('keeps Observe effective rather than promoting it merely because the cap is Prepare',async()=>{
  state.session=SESSIONS.groupAdmin;state.levelA=0;
  const view=wrap('en',await detail('loop_missed_clock_outs'));
  expect(view.container.querySelector(`[data-loop-level-company="${A}"] [data-loop-level]`)).toHaveAttribute('data-loop-level','0');
  expect(view.container.querySelectorAll('[data-loop-level-company] a')).toHaveLength(0);
 });
 it('keeps generic missing-data action controls, request limits and sponsorship visible',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;
  const view=wrap('en',await detail('loop_missing_employee_data'));
  expect([...view.container.querySelectorAll('[data-page-header] [data-loop-level]')].map(text)).toEqual(['Act within limits · Fictional A Sdn Bhd','Prepare · 1 company']);
  const table=view.container.querySelector('[data-loop-actions]')!;
  expect(text(table)).toContain('Request sent to fill in 3 details');
  const forms=[...table.querySelectorAll('form')];expect(forms.map(inputs)).toEqual([['loop=loop_missing_employee_data','action=a1']]);
  expect(forms[0].querySelector('button')).toHaveAttribute('aria-label','Withdraw · Siti Fictional');
  expect([...view.container.querySelectorAll('[data-loop-level-company] a')].map(link=>link.getAttribute('href'))).toEqual([
   `/control-tower/loops/loop_missing_employee_data/promote?company=${A}`,`/control-tower/loops/loop_missing_employee_data/promote?company=${B}`]);
  expect([...view.container.querySelectorAll('[data-loop-limits] li')].map(text)).toContain('Sends the request only; never changes a record');
  for(const button of view.container.querySelectorAll('button'))expect(button.className).toContain('pointer-coarse:min-h-11');
 });
 it('explains human review and sponsorship loss, ignores an unknown notice',async()=>{
  state.session=SESSIONS.hrAdmin;state.sponsorLost=true;
  let view=wrap('en',await detail('loop_missed_clock_outs',{autonomy:'human_review_required'}));
  expect(text(view.container.querySelector('[data-loop-autonomy-notice="human_review_required"]'))).toBe(messagesFor('en').aiCentre.autonomy.notices.human_review_required);
  expect(text(view.container.querySelector('[data-loop-suspended]'))).toBe('Suspended: its sponsor no longer has HR access.');
  cleanup();view=wrap('en',await detail('loop_missed_clock_outs',{autonomy:'<script>'}));
  expect(view.container.querySelector('[data-loop-autonomy-notice]')).toBeNull();
 });
 it('other capped loops also stay at Prepare and offer no promotion',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;
  const view=wrap('en',await detail('loop_probation_ending'));
  expect(text(view.container.querySelector('[data-loop-autonomy-help]'))).toBe(messagesFor('en').aiCentre.autonomy.capped);
  expect(view.container.querySelectorAll('[data-loop-level-company] a')).toHaveLength(0);
  expect(view.container.querySelector('[data-loop-actions]')).toBeNull();
 });
});

describe('level pages distinguish Prepare-only attendance from acting data requests',()=>{
 it.each([1,2,3])('offers no missed-clockout automatic promotion for stored Level %s',async storedLevel=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;state.promoteLevel=storedLevel;
  const view=wrap('en',await promote('loop_missed_clock_outs',{company:B}));
  expect(text(view.container.querySelector('[data-page-header]'))).toContain(messagesFor('en').aiCentre.autonomy.clockOutReviewOnly);
  expect(view.container.querySelector('[data-autonomy-level="1"]')).toHaveAttribute('aria-current','step');
  for(const level of [2,3])expect(text(view.container.querySelector(`[data-autonomy-level="${level}"]`))).toContain('Not for this loop');
  expect(view.container.querySelector('form#autonomy-promote')).toBeNull();
  expect(view.container.querySelector('form#autonomy-limits')).toBeNull();
  expect(view.container.querySelector('[data-autonomy-evidence]')).toBeNull();
  expect(view.container.querySelectorAll('select,input[name=maxActionsPerNight]')).toHaveLength(0);
  const down=screen.getByRole('button',{name:'Move down to Watch'}).closest('form')!;
  expect(inputs(down)).toEqual(['loop=loop_missed_clock_outs',`company=${B}`,'toLevel=0','expectedLevel=1']);
  expect([...view.container.querySelectorAll('input[name=toLevel]')].map(input=>input.getAttribute('value'))).toEqual(['0']);
 });
 it('can return missed-clockout Observe to Prepare, without actor limits or automatic action',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;state.promoteLevel=0;
  const view=wrap('en',await promote('loop_missed_clock_outs',{company:B}));
  const submit=screen.getByRole('button',{name:'Promote to Level 1 in Fictional B Sdn Bhd'}),form=submit.closest('form')!;
  expect(inputs(form)).toEqual(['loop=loop_missed_clock_outs',`company=${B}`,'toLevel=1','expectedLevel=0']);
  expect(view.container.querySelectorAll('select,input[name=maxActionsPerNight]')).toHaveLength(0);
  expect(view.container.querySelector('[data-autonomy-evidence]')).toBeNull();
 });
 it('keeps evidence, request limits and enabled promotion for the missing-data loop',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;
  const view=wrap('en',await promote('loop_missing_employee_data',{company:B}));
  expect(screen.getByRole('heading',{level:1,name:'Let the missing employee data loop act within limits in Fictional B Sdn Bhd?'})).toBeTruthy();
  expect([...view.container.querySelectorAll('[data-autonomy-ladder] li')].map(parts)).toEqual([
   'Level 0 Watch','Level 1 · now Prepare','Level 2 · proposed Act within limits','Level 3 · after 90 days at Level 2 Act and audit']);
  const evidence=view.container.querySelector('[data-autonomy-evidence]')!;
  expect([...evidence.querySelectorAll('tbody tr')].map(row=>[...row.querySelectorAll('th,td')].map(text))).toEqual([
   ['Prepared fixes','200 or more','214','Yes'],['Changed by a person','Under 1%','0.5% (1)','Yes'],['Rule broken','None','None','Yes'],['Time at this level','30 days','34 days','Yes']]);
  expect(view.container.querySelectorAll('[data-autonomy-sample] li')).toHaveLength(2);
  const form=view.container.querySelector('form#autonomy-promote')!;
  expect(inputs(form)).toEqual(['loop=loop_missing_employee_data',`company=${B}`,'toLevel=2','expectedLevel=1','condition=roster_end']);
  expect([...form.querySelectorAll('label > span')].map(text)).toEqual(['Most requests per night','HR can withdraw for']);
  expect(form.querySelector('select[name=condition]')).toBeNull();
  expect([...form.querySelectorAll('select[name=undoDays] option')].map(option=>option.getAttribute('value'))).toEqual(['3','7']);
  expect(screen.getByRole('button',{name:'Promote to Level 2 in Fictional B Sdn Bhd'})).not.toBeDisabled();
  for(const control of view.container.querySelectorAll('button,select,input:not([type=hidden])'))expect(control.className).toContain('pointer-coarse:min-h-11');
 });
 it('keeps generic promotion disabled with the unmet-evidence reason',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;state.certificateMet=false;
  const view=wrap('en',await promote('loop_missing_employee_data',{company:B}));
  expect(view.container.querySelector('[data-autonomy-criterion="prepared"]')).toHaveAttribute('data-met','no');
  const submit=screen.getByRole('button',{name:'Promote to Level 2 in Fictional B Sdn Bhd'});
  expect(submit).toBeDisabled();
  expect(document.getElementById(submit.getAttribute('aria-describedby')!)).toHaveTextContent('Not every requirement is met yet, so it cannot be promoted.');
 });
 it('company HR reads generic request limits without promotion controls',async()=>{
  state.session=SESSIONS.hrAdmin;
  const view=wrap('en',await promote('loop_missing_employee_data',{company:B,error:'refused'}));
  expect(view.container.querySelectorAll('form,select')).toHaveLength(0);
  expect(text(view.container)).toContain("Only a group administrator can change a loop's level.");
  expect([...view.container.querySelectorAll('dl div')].map(parts)).toEqual(['Most requests per night 50','HR can withdraw for 3 days','Tell each person Always (fixed)','Drop back to Prepare when Over 1% changed in 7 days (fixed)']);
 });
 it('company HR cannot promote even a stale acting missed-clockout configuration',async()=>{
  state.session=SESSIONS.hrAdmin;state.promoteLevel=3;
  const view=wrap('en',await promote('loop_missed_clock_outs',{company:B}));
  expect(view.container.querySelectorAll('form,select')).toHaveLength(0);
  expect(text(view.container)).toContain(messagesFor('en').aiCentre.autonomy.clockOutReviewOnly);
 });
 it('does not reveal a company outside the view or an unknown loop',async()=>{
  state.session=SESSIONS.groupAdmin;
  await expect(promote('loop_missed_clock_outs',{company:A})).rejects.toMatchObject({notFound:true});
  await expect(promote('loop_invented',{company:B})).rejects.toMatchObject({notFound:true});
 });
 it('keeps editable stricter limits and a separate audit-level promotion for the generic actor',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;state.promoteLevel=2;state.promoteUndo=7;
  const view=wrap('en',await promote('loop_missing_employee_data',{company:B}));
  const form=view.container.querySelector('form#autonomy-limits')!;
  expect(inputs(form)).toEqual(['loop=loop_missing_employee_data',`company=${B}`,'expectedVersion=4','condition=roster_end']);
  expect(form.querySelector('input[name=maxActionsPerNight]')).toHaveAttribute('max','50');
  expect([...form.querySelectorAll('select[name=undoDays] option')].map(option=>option.getAttribute('value'))).toEqual(['7']);
  expect(text(form)).toContain('Without a promotion the limits can only be made stricter');
  expect(inputs(view.container.querySelector('form#autonomy-promote')!)).toEqual(['loop=loop_missing_employee_data',`company=${B}`,'toLevel=3','expectedLevel=2','condition=roster_end']);
 });
 it('keeps the weekly reviewed sample only for an acting generic loop',async()=>{
  state.session=SESSIONS.groupAdmin;state.canChange=true;state.levelA=3;
  const view=wrap('en',await detail('loop_missing_employee_data'));
  const sample=view.container.querySelector(`[data-loop-sample="${A}"]`)!;
  expect(text(sample)).toContain('1 of 12 actions in the week of Nov 2, 2026');
  expect(inputs(sample.querySelector('form')!)).toEqual(['loop=loop_missing_employee_data',`company=${A}`,'week=2026-11-02']);
  expect(sample.querySelector('button')).toHaveAttribute('aria-label','Mark the sample reviewed · Fictional A Sdn Bhd');
 });
 it("shows effective capped missed-clockout overview summaries and preserves other loops' Act summaries",async()=>{
  state.session=SESSIONS.groupAdmin;state.summaries={loop_missed_clock_outs:[{level:3,count:1},{level:2,count:1},{level:1,count:3}],loop_missing_employee_data:[{level:2,count:1},{level:1,count:4}],loop_probation_ending:[{level:1,count:5}]};
  const view=wrap('en',await resolveServerTree(await LoopsPage({searchParams:Promise.resolve({})})));
  const cell=(id:string)=>text(view.container.querySelector(`[data-loop-row="${id}"] [data-loop-level-summary]`));
  expect(cell('loop_missed_clock_outs')).toBe('Prepare');
  expect(cell('loop_missing_employee_data')).toBe('Act within limits · 1 company · Prepare · 4 companies');
  expect(cell('loop_probation_ending')).toBe('Prepare');
 });
});

const historicalCard={kind:'autoFixed',actionId:'00000000-0000-4000-8000-00000000ac71',date:'2026-11-02',checkOut:'18:00',undoUntil:'2099-01-01T00:00:00.000Z'} as const;
describe('Today historical attendance actions require human review',()=>{
 it('preserves the historical result and opens a correction without offering or posting automatic Undo',async()=>{
  const view=wrap('en',<ul>{await LoopCards({cards:[historicalCard] as never,locale:'en'})}</ul>);
  const fixed=view.container.querySelector('[data-today-loop="autoFixed"]')!;
  expect(text(fixed.querySelector('h3'))).toBe('Clock-out set to 18:00 for Mon, Nov 2');
  expect(text(fixed)).toContain('Done by AI Centre: Missed clock-outs');
  expect(text(fixed)).toContain(messagesFor('en').today.autonomy.refused.human_review_required);
  expect(text(fixed)).not.toContain('You can undo it until');
  expect(within(fixed as HTMLElement).getByRole('link',{name:'Review correction'})).toHaveAttribute('href','/attendance/my-records/2026-11-02');
  expect(within(fixed as HTMLElement).queryByRole('button',{name:/^Undo/})).toBeNull();
  expect(state.undo.posts).toEqual([]);
 });
 it('keeps missed-clockout history cards as review findings without promising promotion or Undo',async()=>{
  const href='/control-tower/loops/loop_missed_clock_outs';
  const feed=[
   {kind:'movedDown',changeId:'history-change',workerId:'loop_missed_clock_outs',companyName:'Fictional A Sdn Bhd',at:'2026-11-03T15:05:00.000Z',applied:50,corrected:2,corrections:[{personName:'Daniel Fictional',date:'2026-11-02',kind:'undone',by:'employee'}],more:0,href},
   {kind:'acted',workerId:'loop_missed_clock_outs',companyId:A,companyName:'Fictional A Sdn Bhd',count:2,items:[{personName:'Siti Fictional',date:'2026-11-02',reason:null}],more:0,href},
   {kind:'sample',workerId:'loop_missed_clock_outs',companyId:B,companyName:'Fictional B Sdn Bhd',weekStart:'2026-11-02',size:5,total:12,href},
  ];
  const view=wrap('en',<ul>{await LoopCards({cards:feed as never,locale:'en'})}</ul>);
  for(const kind of ['movedDown','acted','sample']){
   const card=view.container.querySelector(`[data-today-loop="${kind}"]`)!;
   expect(text(card)).toContain(messagesFor('en').today.autonomy.refused.human_review_required);
   expect(text(card)).not.toContain('until a group administrator promotes it');
   expect(text(card)).not.toContain('Open the loop to undo one');
  }
  expect(text(view.container)).toContain('Daniel Fictional · Mon, Nov 2 · undone by the employee');
  expect(view.container.querySelectorAll('button')).toHaveLength(0);
  expect(state.undo.posts).toEqual([]);
 });
 it('retains generic acting-loop Today notes and navigation',async()=>{
  const feed=[{kind:'acted',workerId:'loop_missing_employee_data',companyId:A,companyName:'Fictional A Sdn Bhd',count:2,items:[{personName:'Siti Fictional',date:'2026-11-02',reason:null}],more:0,href:'/control-tower/loops/loop_missing_employee_data'}];
  const view=wrap('en',<ul>{await LoopCards({cards:feed as never,locale:'en'})}</ul>);
  expect(text(view.container)).toContain(messagesFor('en').today.autonomy.actedNote);
  expect(screen.getByRole('link')).toHaveAttribute('href','/control-tower/loops/loop_missing_employee_data');
 });

});

describe('every locale',()=>{
 it.each(['ms','zh','vi','ta','th'] as const)('%s renders review-only attendance and generic request controls without missing copy',async locale=>{
  state.locale=locale;state.session=SESSIONS.groupAdmin;state.canChange=true;
  const copy=messagesFor(locale);
  let view=wrap(locale,await detail('loop_missed_clock_outs',{autonomy:'human_review_required'}));
  expect(screen.getByRole('heading',{level:1,name:copy.aiCentre.loops.names.loop_missed_clock_outs})).toBeTruthy();
  expect(text(view.container)).toContain(copy.aiCentre.autonomy.clockOutReviewOnly);
  expect(text(view.container)).not.toMatch(/noveri/i);cleanup();
  view=wrap(locale,await promote('loop_missed_clock_outs',{company:B}));
  expect(text(view.container)).toContain(copy.aiCentre.autonomy.clockOutReviewOnly);
  expect(view.container.querySelector('form#autonomy-promote')).toBeNull();cleanup();
  view=wrap(locale,await promote('loop_missing_employee_data',{company:B}));
  expect(view.container.querySelector('form#autonomy-promote')).not.toBeNull();
  expect(text(view.container)).toContain(copy.aiCentre.autonomy.promote.tellValue);cleanup();
  view=wrap(locale,<ul>{await LoopCards({cards:[historicalCard] as never,locale})}</ul>);
  expect(text(view.container)).toContain(copy.today.autonomy.refused.human_review_required);
  expect(text(view.container)).toContain(copy.today.autonomy.reviewCorrection);
  expect(view.container.querySelector('button')).toBeNull();
  expect(text(view.container)).not.toMatch(/noveri/i);
 });
});
