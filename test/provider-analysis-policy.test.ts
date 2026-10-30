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
  const rare=fixture();for(const row of rare.cohorts[0].records)if(row.period==='current')row.attendanceBand=Number(row.personKey.slice(-12))<=10?'high':'mixed';
  rare.cohorts[0].records.find(row=>row.personKey===id(1)&&row.period==='current')!.attendanceBand='mixed';
  rare.cohorts[0].records.find(row=>row.personKey===id(11)&&row.period==='current')!.attendanceBand='high';
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

import {PROVIDER_ANALYSIS_CONTRACT,prepareProviderAnalysis,inspectPreparedProviderAnalysis,retireProviderAnalysis,assertProviderAnalysisReviewApproved,fingerprintProviderAnalysisSource,type ProviderAnalysisBinding} from '../lib/ai/provider-analysis-policy';
import {PROVIDER_ANALYSIS_COVERAGE,type ProviderAnalysisDomain} from '../lib/ai/provider-analysis-coverage';
import {AI_FEATURES,type AiFeatureId} from '../lib/ai/features';
type MetricInput={metric:string;support:number;changeBand:string;drivers:{code:string;relationship:string}[];slices:{category:string;people:number;changeBand:string}[]};
type AggregateInput={version:number;domain:ProviderAnalysisDomain;window:string;cohorts:{cohort:string;population:number;metrics:MetricInput[]}[]};
const aggregateFixture=(domain:ProviderAnalysisDomain,metric:string,other:string,driver:string,category:string):AggregateInput=>({version:1,domain,window:'calendar_month',cohorts:['cohort_a','cohort_b'].map((cohort,index)=>({cohort,population:37,
 metrics:[{metric,support:37,changeBand:index===0?'increase_10_to_25_percent':'increase_up_to_5_percent',drivers:[{code:driver,relationship:index===0?'recorded_contributor':'associated_change'}],slices:[{category,people:7,changeBand:'increase_5_to_10_percent'}]},
 {metric:other,support:37,changeBand:index===0?'increase_5_to_10_percent':'unchanged',drivers:[],slices:[]}]}))});
const aggregateBinding=(source:unknown,feature:AiFeatureId='hr_assistant'):ProviderAnalysisBinding=>({feature,operation:feature==='hr_assistant'?'conversation':'draft',contractId:PROVIDER_ANALYSIS_CONTRACT,
 principalDigest:'1'.repeat(64),scopeDigest:'2'.repeat(64),providerSnapshotDigest:'3'.repeat(64),sourceFingerprint:fingerprintProviderAnalysisSource(source),expiresAt:Date.now()+60000});
type AggregateOutput={domain:string;window:string;scale:string;periods:{reference:string;comparison:string};cohorts:{cohort:string;populationBand:string;metrics:{metric:string;supportBand:string;changeBand:string;
 drivers:{code:string;relationship:string}[];slicesMayOverlap:boolean;slices:{category:string;peopleBand:string;changeBand:string}[]}[]}[]};
const cases:[ProviderAnalysisDomain,AiFeatureId,string,string,string,string][]=[
 ['payroll','payroll_explanation','payroll_cost','overtime_cost','recorded_overtime_change','overtime'],
 ['claims','claims_triage','expense_total','claim_volume','recorded_claim_volume','travel'],
 ['workforce','report_insight','active_workforce','onboarding_completion','recorded_hiring_volume','employees'],
 ['performance','performance_pm','review_completion','development_plan_completion','recorded_cycle_progress','completed'],
 ['attendance','hr_assistant','absence_frequency','overtime_hours','recorded_attendance_change','absence'],
 ['leave','hr_assistant','leave_taken','leave_pending','recorded_request_volume','approved'],
 ['rewards','performance_calib','budget_utilisation','review_completion','recorded_budget_change','in_review'],
 ['organisation','readiness_reminders','open_workload','overdue_workload','recorded_intake_change','open'],
];
describe('reusable feature-specific aggregate analysis candidates',()=>{
 it.each(cases)('preserves useful %s metric/cohort/period comparisons for %s while withholding exact native measurements', (domain,feature,metric,other,driver,category)=>{
  const source=aggregateFixture(domain,metric,other,driver,category),current=aggregateBinding(source,feature),cap=prepareProviderAnalysis(current,source),review=inspectPreparedProviderAnalysis(cap,current),out=JSON.parse(review.json) as AggregateOutput;
  expect(out.domain).toBe(domain);expect(out.periods).toEqual({reference:'previous_period',comparison:'current_period'});expect(out.scale).toBe('native_source_relative_change_bands');
  // Independent expectation: the first cohort's primary change is larger than the second cohort's;
  // the related native metric changed in A but remained unchanged in B. No model arithmetic is needed.
  expect(out.cohorts.map(cohort=>cohort.metrics.map(row=>[row.metric,row.changeBand]))).toEqual([
   [[metric,'increase_10_to_25_percent'],[other,'increase_5_to_10_percent']],[[metric,'increase_up_to_5_percent'],[other,'unchanged']],
  ]);
  expect(out.cohorts[0].metrics[0].drivers).toEqual([{code:driver,relationship:'recorded_contributor'}]);
  expect(out.cohorts[1].metrics[0].drivers).toEqual([{code:driver,relationship:'associated_change'}]);
  for(const cohort of out.cohorts){expect(cohort.populationBand).toBe('20_to_49');for(const row of cohort.metrics){expect(row.supportBand).toBe('20_to_49');expect(row.slicesMayOverlap).toBe(true);}}
  expect(out.cohorts[0].metrics[0].slices).toEqual([{category,peopleBand:'5_to_9',changeBand:'increase_5_to_10_percent'}]);
  expect(review.json).not.toContain('37');expect(review.json).not.toMatch(/"(?:population|support|people|amount|salary|rating|personKey|date)":/);
  expect(review.reviewStatus).toBe('approved');expect(review.sourceStatus).toBe('requires_native_owner_replay');expect(()=>assertProviderAnalysisReviewApproved(cap,current)).not.toThrow();retireProviderAnalysis(cap);
 });
 it('binds the canonical original source exactly and does not manufacture source authority or review acceptance',()=>{
  const source=aggregateFixture('payroll','payroll_cost','headcount','recorded_headcount_change','base_pay'),current=aggregateBinding(source,'payroll_explanation');
  const reordered={cohorts:source.cohorts,window:source.window,domain:source.domain,version:1};expect(fingerprintProviderAnalysisSource(reordered)).toBe(current.sourceFingerprint);
  const cap=prepareProviderAnalysis(current,source),projection=inspectPreparedProviderAnalysis(cap,current);expect(projection.originalSourceFingerprint).toBe(current.sourceFingerprint);
  source.cohorts[0].metrics[0].changeBand='unchanged';expect(()=>prepareProviderAnalysis(current,source)).toThrow('aggregate analysis disclosure policy');
  expect(()=>prepareProviderAnalysis({...current,reviewed:true},source)).toThrow();expect(()=>prepareProviderAnalysis(current,{...source,authorized:true})).toThrow();
  expect(inspectPreparedProviderAnalysis(cap,current)).toBe(projection);retireProviderAnalysis(cap);
 });
 it('refuses small cohorts, unsupported metrics, incompatible feature domains and tiny contributing slices',()=>{
  const source=aggregateFixture('claims','expense_total','claim_volume','recorded_claim_volume','travel'),current=aggregateBinding(source,'claims_triage');
  const small=structuredClone(source);small.cohorts[0].population=19;
  const support=structuredClone(source);support.cohorts[0].metrics[0].support=19;
  const tiny=structuredClone(source);tiny.cohorts[0].metrics[0].slices[0].people=4;
  const unknown=structuredClone(source);unknown.cohorts[0].metrics[0].metric='individual_salary';
  const mismatched=structuredClone(source);mismatched.cohorts[1].metrics.pop();
  for(const value of [small,support,tiny,unknown,mismatched])expect(()=>fingerprintProviderAnalysisSource(value)).toThrow();
  expect(()=>prepareProviderAnalysis({...current,feature:'payroll_explanation'},source)).toThrow();
  expect(()=>prepareProviderAnalysis({...current,feature:'personnel_import_mapping'},source)).toThrow();
 });
 it('blocks private scalar/prose/image variants and never evaluates getters, prototypes or proxy traps',()=>{
  const source=aggregateFixture('workforce','active_workforce','joiners','recorded_hiring_volume','employees'),current=aggregateBinding(source,'report_insight');
  for(const field of [{employeeName:'PRIVATE_PERSON'},{email:'private@example.test'},{amount:987654.32},{date:'2026-10-30'},{rawPrompt:'PRIVATE_PROSE'},{image:new Uint8Array([1,2])}])expect(()=>fingerprintProviderAnalysisSource({...source,...field})).toThrow();
  let invoked=false;const getter={...source,get cohorts(){invoked=true;return [];}};expect(()=>prepareProviderAnalysis(current,getter)).toThrow();
  const proxy=new Proxy(source,{getPrototypeOf(){invoked=true;return Object.prototype;}});expect(()=>prepareProviderAnalysis(current,proxy)).toThrow();expect(invoked).toBe(false);
  for(const raw of ['PRIVATE PROSE',new Uint8Array([1,2]),Object.assign(Object.create({private:true}),source)])expect(()=>fingerprintProviderAnalysisSource(raw)).toThrow();
 });
 it('keeps exact capabilities scoped, short-lived and non-serializable',()=>{
  vi.useFakeTimers();const source=aggregateFixture('performance','review_completion','goal_progress','recorded_cycle_progress','completed'),current=aggregateBinding(source,'performance_review'),cap=prepareProviderAnalysis(current,source);
  expect(JSON.stringify(cap)).toBe('{}');expect(()=>inspectPreparedProviderAnalysis({...cap},current)).toThrow();
  for(const key of ['principalDigest','scopeDigest','providerSnapshotDigest','sourceFingerprint'])expect(()=>inspectPreparedProviderAnalysis(cap,{...current,[key]:'a'.repeat(64)})).toThrow();
  vi.advanceTimersByTime(60000);expect(()=>inspectPreparedProviderAnalysis(cap,current)).toThrow();
 });
 it('allows the dedicated fixed-input DRAFT analysis path for Assistant/reporting without admitting ordinary raw conversation or prompts',()=>{
  const source=aggregateFixture('attendance','absence_frequency','overtime_hours','recorded_attendance_change','absence');
  for(const feature of ['hr_assistant','report_insight'] as const){const current={...aggregateBinding(source,feature),operation:'draft' as const},cap=prepareProviderAnalysis(current,source);expect(inspectPreparedProviderAnalysis(cap,current).purpose).toBe('aggregate_comparison_analysis');retireProviderAnalysis(cap);}
  expect(()=>prepareProviderAnalysis({...aggregateBinding(source),operation:'draft'},'PRIVATE RAW PROMPT')).toThrow();
 });
 it('records every AI feature explicitly, including blocked import/vision/drafting variants, without granting unsupported feature variants',()=>{
  expect(PROVIDER_ANALYSIS_COVERAGE.map(row=>row.feature)).toEqual(AI_FEATURES.map(row=>row.id));expect(PROVIDER_ANALYSIS_COVERAGE.every(row=>row.reviewStatus==='approved')).toBe(true);
  expect(PROVIDER_ANALYSIS_COVERAGE.find(row=>row.feature==='personnel_import_mapping')).toMatchObject({domains:[],operations:[]});
  for(const row of PROVIDER_ANALYSIS_COVERAGE)expect(row.blockedVariants).toEqual(expect.arrayContaining(['raw_images','raw_free_text','unstructured_drafting','individual_ratings_or_recommendations']));
 });
});
