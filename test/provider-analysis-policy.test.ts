/** Local pending review artifacts only; no source authorization or specialist acceptance is invented. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ATTENDANCE_ANALYSIS_CONTRACT,prepareAttendanceTrendAnalysis,inspectAttendanceTrendAnalysis,resolveAttendancePersonAlias,retireAttendanceTrendAnalysis,assertAttendanceTrendReviewApproved,type AttendanceAnalysisBinding} from '../lib/ai/provider-analysis-policy';
const binding=():AttendanceAnalysisBinding=>({feature:'hr_assistant',operation:'conversation',contractId:ATTENDANCE_ANALYSIS_CONTRACT,principalDigest:'1'.repeat(64),scopeDigest:'2'.repeat(64),providerSnapshotDigest:'3'.repeat(64),sourceFingerprint:'4'.repeat(64),expiresAt:Date.now()+60000});
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const fixture=()=>({version:1,window:'four_weeks',cohorts:[0,1].map(cohort=>({cohort:cohort===0?'cohort_a':'cohort_b',trend:{attendance:cohort===0?'improved':'declined',punctuality:'steady'},
 records:Array.from({length:20},(_,person)=>['previous','current'].map(period=>({personKey:id(cohort*20+person+1),period,
  attendanceBand:cohort===0?(period==='previous'&&person<10?'mixed':'high'):(period==='current'&&person<10?'mixed':'high'),punctualityBand:'on_time'}))).flat()}))});
type Emitted={purpose:string;window:string;cohorts:{cohort:string;trend:{attendance:string;punctuality:string};records:{person:string;period:string;attendanceBand:string;punctualityBand:string}[]}[]};
const emitted=(json:string)=>JSON.parse(json) as Emitted;
afterEach(()=>vi.useRealTimers());
describe('useful pending attendance trend projection',()=>{
 it('preserves within-person period relationships and independently distinguishable cohort trends without names, IDs or dates',()=>{
  const current=binding(),source=fixture(),cap=prepareAttendanceTrendAnalysis(current,source),review=inspectAttendanceTrendAnalysis(cap,current),out=emitted(review.json);
  expect(out.purpose).toBe('attendance_trend_analysis');expect(out.window).toBe('four_weeks');
  expect(out.cohorts.map(cohort=>[cohort.cohort,cohort.trend.attendance])).toEqual([['cohort_a','improved'],['cohort_b','declined']]);
  const transitions=out.cohorts.map(cohort=>{
   const people=new Map<string,typeof cohort.records>();for(const row of cohort.records)people.set(row.person,[...(people.get(row.person)??[]),row]);
   const result:string[]=[];for(const [alias,rows] of people){expect(alias).toMatch(/^person_[A-Za-z0-9_-]{24}$/);expect(rows).toHaveLength(2);expect(new Set(rows.map(row=>row.period))).toEqual(new Set(['previous','current']));
    const previous=rows.find(row=>row.period==='previous')!,now=rows.find(row=>row.period==='current')!;result.push(previous.attendanceBand+'->'+now.attendanceBand);
    expect(resolveAttendancePersonAlias(cap,current,alias)).toMatch(/^00000000-0000-4000-8000-/);
   }return result.sort();
  });
  // An explanation can distinguish a cohort improving from mixed to high from a declining cohort.
  expect(transitions[0]).toEqual([...Array(10).fill('high->high'),...Array(10).fill('mixed->high')]);
  expect(transitions[1]).toEqual([...Array(10).fill('high->high'),...Array(10).fill('high->mixed')]);
  for(const cohort of source.cohorts)for(const row of cohort.records)expect(review.json).not.toContain(row.personKey);
  expect(review.json).not.toMatch(/personKey|2026-|salary|amount|employeeName|email/);expect(review.reviewStatus).toBe('pending');expect(review.sourceStatus).toBe('requires_native_owner_replay');
  expect(()=>assertAttendanceTrendReviewApproved(cap,current)).toThrow();retireAttendanceTrendAnalysis(cap);
 });
 it('refuses small cohorts, tiny nonzero category slices and rare paired histories even inside a large cohort',()=>{
  const current=binding(),small=fixture();small.cohorts[0].records=small.cohorts[0].records.slice(0,38);
  const tiny=fixture();tiny.cohorts[0].records[0].attendanceBand='low';
  // All individual category slices remain >=5, but one unique paired history has only one person.
  const rare=fixture();rare.cohorts[0].records.find(row=>row.personKey===id(1)&&row.period==='current')!.attendanceBand='mixed';
  for(const source of [small,tiny,rare])expect(()=>prepareAttendanceTrendAnalysis(current,source)).toThrow('attendance analysis disclosure policy');
 });
 it('refuses overlapping/duplicate/missing person-period membership and raw individual fields or unsupported windows',()=>{
  const current=binding(),overlap=fixture();overlap.cohorts[1].records[0].personKey=id(1);
  const duplicate=fixture();duplicate.cohorts[0].records[1].period='previous';
  const missing=fixture();missing.cohorts[0].records.pop();
  const raw=fixture();Object.assign(raw.cohorts[0].records[0],{employeeName:'PRIVATE_NAME',date:'2026-10-30',salary:12345});
  const time=fixture();time.window='2026-10';
  for(const source of [overlap,duplicate,missing,raw,time,'PRIVATE FREE PROSE',new Uint8Array([1,2])])expect(()=>prepareAttendanceTrendAnalysis(current,source)).toThrow();
 });
 it('keeps aliases request-local and refuses copied/wrong-scope/expired capabilities and caller approval assertions',()=>{
  vi.useFakeTimers();const current=binding(),first=prepareAttendanceTrendAnalysis(current,fixture()),second=prepareAttendanceTrendAnalysis(current,fixture());
  const a=emitted(inspectAttendanceTrendAnalysis(first,current).json).cohorts[0].records[0].person,b=emitted(inspectAttendanceTrendAnalysis(second,current).json).cohorts[0].records[0].person;expect(a).not.toBe(b);
  expect(()=>resolveAttendancePersonAlias(second,current,a)).toThrow();expect(()=>inspectAttendanceTrendAnalysis({...first},current)).toThrow();
  for(const key of ['principalDigest','scopeDigest','providerSnapshotDigest','sourceFingerprint'])expect(()=>inspectAttendanceTrendAnalysis(first,{...current,[key]:'a'.repeat(64)})).toThrow();
  expect(()=>prepareAttendanceTrendAnalysis({...current,reviewed:true},fixture())).toThrow();
  vi.advanceTimersByTime(60000);expect(()=>inspectAttendanceTrendAnalysis(first,current)).toThrow();expect(()=>resolveAttendancePersonAlias(second,current,b)).toThrow();
 });
 it('does not invoke accessors/proxy traps or accept hidden fields as a provenance substitute',()=>{
  const current=binding();let invoked=false;const source={version:1,window:'four_weeks',get cohorts(){invoked=true;return [];}};
  expect(()=>prepareAttendanceTrendAnalysis(current,source)).toThrow();const proxy=new Proxy(fixture(),{getPrototypeOf(){invoked=true;return Object.prototype;}});expect(()=>prepareAttendanceTrendAnalysis(current,proxy)).toThrow();expect(invoked).toBe(false);
  expect(()=>prepareAttendanceTrendAnalysis(current,{...fixture(),authorized:true})).toThrow();
 });
});
