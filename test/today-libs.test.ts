/** AI v2 Phase 1, W3 — Today's pure parts: who it is drawn for, the HR-date window, the manager's absences and the
 * Ask bar's handoff to AI Centre Ask. No database, no React. */
import {describe,expect,it} from 'vitest';
import {addHrDays,greetingFor,greetingName,todayAudience,windowStart} from '../lib/today/audience';
import {managerAbsences} from '../lib/today/coming-up';
import {ASK_HANDOFF_KEY,HANDOFF_TTL_MS,MAX_HANDOFF_CHARS,storeAskHandoff,takeAskHandoff} from '../lib/today/ask-handoff';

const session=(roles:string[],grants:{role:string;companyId:string|null}[]=[])=>({tenantId:'t',userId:'u',personId:'p',roles,grants}) as never;

describe('audience',()=>{
 it('draws the administrator layout only for HR and super administrators',()=>{
  expect(todayAudience(session(['employee']))).toEqual({layout:'personal',groupAdmin:false,manager:false});
  expect(todayAudience(session(['manager']))).toEqual({layout:'personal',groupAdmin:false,manager:true});
  expect(todayAudience(session(['payroll_partner'],[{role:'payroll_partner',companyId:null}]))).toEqual({layout:'personal',groupAdmin:false,manager:false});
  expect(todayAudience(session(['hr_admin'],[{role:'hr_admin',companyId:'co-a'}]))).toEqual({layout:'administrator',groupAdmin:false,manager:false});
  expect(todayAudience(session(['hr_admin'],[{role:'hr_admin',companyId:null}]))).toEqual({layout:'administrator',groupAdmin:true,manager:false});
 });
 it('counts seven HR days, today included, from midnight in Malaysia',()=>{
  expect(windowStart('2026-11-04').toISOString()).toBe('2026-10-28T16:00:00.000Z');
  expect(windowStart('2026-03-01').toISOString()).toBe('2026-02-22T16:00:00.000Z');
  expect(addHrDays('2026-12-31',1)).toBe('2027-01-01');
  expect(()=>addHrDays('4/11/2026',1)).toThrow();
 });
 it('greets by the hour of the Malaysian day and by the first word of the name',()=>{
  expect([0,11,12,17,18,23].map(greetingFor)).toEqual(['greetingMorning','greetingMorning','greetingAfternoon','greetingAfternoon','greetingEvening','greetingEvening']);
  expect(greetingName('  Ravi  Fictional ')).toBe('Ravi');
  expect(greetingName('')).toBeNull();
  expect(greetingName(null)).toBeNull();
 });
});

describe('managerAbsences',()=>{
 const day=(date:string,ids:string[],available=true)=>({date,available,items:ids.map(id=>({employmentId:id,name:id==='m1'?'Siti Fictional':id==='m2'?'Daniel Fictional':'Peer'}))});
 it('joins consecutive days into one run per manager and ignores everyone else',()=>{
  expect(managerAbsences(['m1','m2'],[day('2026-11-07',['m1']),day('2026-11-06',['m1','p']),day('2026-11-08',[]),day('2026-11-09',['m1','m2']),day('2026-11-10',['m2'])])).toEqual([
   {employmentId:'m1',name:'Siti Fictional',from:'2026-11-06',to:'2026-11-07'},
   {employmentId:'m2',name:'Daniel Fictional',from:'2026-11-09',to:'2026-11-10'},
   {employmentId:'m1',name:'Siti Fictional',from:'2026-11-09',to:'2026-11-09'},
  ]);
 });
 it('shows nothing for a day the sharing policy does not make available, or without managers',()=>{
  expect(managerAbsences(['m1'],[day('2026-11-06',['m1'],false)])).toEqual([]);
  expect(managerAbsences([],[day('2026-11-06',['m1'])])).toEqual([]);
 });
});

describe('Ask handoff',()=>{
 const memory=()=>{const map=new Map<string,string>();return {map,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);}};};
 const ask={pathname:'/assistant',search:''};
 it('carries the question once, to a fresh Ask page, and removes it on reading',()=>{
  const store=memory();
  expect(storeAskHandoff(store,'  How much leave do I have?  ',1_000)).toBe(true);
  expect(takeAskHandoff(store,ask,1_500)).toBe('How much leave do I have?');
  expect(store.map.has(ASK_HANDOFF_KEY)).toBe(false);
  expect(takeAskHandoff(store,ask,1_600)).toBeNull();
 });
 it('drops a stale handoff, or one read anywhere but a fresh Ask page, unsent',()=>{
  for(const [where,at] of [[ask,1_000+HANDOFF_TTL_MS+1],[{pathname:'/',search:''},1_100],[{pathname:'/assistant',search:'?view=inbox'},1_100],
   [{pathname:'/assistant',search:'?chat=c1'},1_100],[{pathname:'/assistant',search:'?e=x'},1_100],[ask,999]] as const){
   const store=memory();storeAskHandoff(store,'Why is my pay different?',1_000);
   expect(takeAskHandoff(store,where,at)).toBeNull();
   expect(store.map.size).toBe(0);
  }
 });
 it('refuses nothing to keep, no storage, a broken value and an over-long question',()=>{
  const store=memory();
  expect(storeAskHandoff(store,'   ')).toBe(false);
  expect(storeAskHandoff(null,'Hello')).toBe(false);
  expect(takeAskHandoff(null,ask)).toBeNull();
  store.setItem(ASK_HANDOFF_KEY,'not json');expect(takeAskHandoff(store,ask)).toBeNull();
  store.setItem(ASK_HANDOFF_KEY,JSON.stringify({q:42,at:1}));expect(takeAskHandoff(store,ask,2)).toBeNull();
  storeAskHandoff(store,'x'.repeat(MAX_HANDOFF_CHARS+50),1);
  expect(takeAskHandoff(store,ask,2)).toBe('x'.repeat(MAX_HANDOFF_CHARS));
  const throwing={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');},removeItem:()=>{throw Error('blocked');}};
  expect(storeAskHandoff(throwing,'Hello')).toBe(false);
  expect(takeAskHandoff(throwing,ask)).toBeNull();
 });
});
