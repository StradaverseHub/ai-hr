/** Pure formula proposals. No row, policy activation, approval, source reservation or payment. */
import {describe,expect,it} from 'vitest';
import {evaluateOvertimePolicyAllocatedParentPrice,evaluateOvertimePolicyAllocatedPrice,evaluateOvertimePattern,evaluateOvertimePatternDuration,evaluateOvertimePolicyPart,evaluateOvertimePolicyPartDuration,type OvertimePolicyRoundedCount,type OvertimePolicyApprovedPlanCount,validateOvertimeInput,validateOvertimePolicyInput} from '../lib/overtime-pattern-evaluate';
import {parseRecordedOvertimeEvaluation,parseRecordedOvertimeDurationEvaluation,parseRecordedOvertimePolicyEvaluation,parseRecordedOvertimePolicyDurationEvaluation} from '../lib/overtime-pattern-result';
import {overtimeSourceKey,type OvertimeFact,type OvertimeInput,type OvertimePattern} from '../lib/overtime-pattern-model';
import type {OvertimePolicyBinding} from '../lib/overtime-pattern-binding';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const date='2024-02-29',currency={code:'MYR',minorScale:2};
const fact=<T>(value:T,owner:'attendance'|'approval'|'personnel'|'payroll'='attendance'):OvertimeFact<T>=>({state:'known',value,provenance:{owner,reference:'fictional_'+owner,asOf:date,basis:'recorded'}});
function definition():OvertimePattern{return {v:1,currency,definitions:[],eligibilityBasis:'day',durationAllocation:'earliest',eligibility:{id:'eligible',type:'constant',value:true},
  eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Fictional rate',description:'No statutory assurance',priority:0,
    when:{id:'rate_eligible',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:uuid(20),currency:'MYR'},
      payment:{method:'hourly',rate:{id:'hourly',type:'literal',unit:'moneyPerHour',value:'12',currency:'MYR'},multiplier:{id:'multiplier',type:'literal',unit:'scalar',value:'1.5'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};}
function assigned():OvertimeInput{return {mode:'actual',sessionGranularity:'recorded',layer:'raw',source:{tenantId:uuid(1),employmentId:uuid(2),attendanceId:uuid(3),date,inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},
  patternVersionId:uuid(4),assignmentId:uuid(5),currency,facts:{employmentId:fact(uuid(2),'personnel'),companyId:fact(uuid(10),'personnel'),dayType:fact('workday'),actualWorkingMinutes:fact('120'),requiredWorkingMinutes:fact('0'),lateMinutes:fact('0'),basicSalary:fact('3000','payroll')},
  resources:[],approval:{status:'approved',minutes:fact('120','approval'),provenance:{owner:'approval',reference:uuid(6),asOf:date,basis:'recorded'}},
  segments:[{id:'segment',sessionId:'session',dayType:fact('workday'),clock:{state:'unknown',reason:'unrecordedPlacement'},rawMinutes:fact('120'),approvedMinutes:fact('120','approval')}]};}
function policy():OvertimeInput<OvertimePolicyBinding>{return {...assigned(),assignmentId:null,policyBinding:{kind:'attendanceGroupPolicy',revisionId:uuid(7),dayClass:'off',calendarDate:'2024-03-01',dayOffset:1}};}
describe('explicit formula binding adapters',()=>{
  it('uses the same exact money and duration engine with a real policy reference and no invented assignment',()=>{
    const input=policy(),before=structuredClone(input),result=evaluateOvertimePolicyPart(definition(),input),duration=evaluateOvertimePolicyPartDuration(definition(),input);
    const original=evaluateOvertimePattern(definition(),assigned()),originalDuration=evaluateOvertimePatternDuration(definition(),assigned());
    expect(result.status).toBe('ready');expect(duration.status).toBe('ready');
    if(result.status==='refused'||original.status==='refused'||duration.status==='refused'||originalDuration.status==='refused')throw Error('Expected evidenced formula proposals');
    expect(result.assignmentId).toBeNull();expect(result.policyBinding).toEqual(input.policyBinding);expect(duration.policyBinding).toEqual(input.policyBinding);
    expect(result.amountMinorUnits).toBe('3600');expect(result.amountMinorUnits).toBe(original.amountMinorUnits);expect(result.lines).toEqual(original.lines);
    expect(duration.payableMinutes).toEqual({unit:'minutes',numerator:'120',denominator:'1'});expect(duration.allocations).toEqual(originalDuration.allocations);
    expect(overtimeSourceKey(result.source)).toBe(overtimeSourceKey(original.source));expect(input).toEqual(before);
    expect(parseRecordedOvertimePolicyEvaluation(result)).toEqual(result);expect(parseRecordedOvertimePolicyDurationEvaluation(duration)).toEqual(duration);
    expect(parseRecordedOvertimePolicyEvaluation(original)).toBeNull();expect(parseRecordedOvertimePolicyDurationEvaluation(originalDuration)).toBeNull();
  });
  it('keeps the legacy validator and immutable readers closed to policy results',()=>{
    expect(()=>validateOvertimeInput(policy())).toThrow();expect(()=>validateOvertimePolicyInput(assigned())).toThrow();
    expect(parseRecordedOvertimeEvaluation(evaluateOvertimePolicyPart(definition(),policy()))).toBeNull();
    expect(parseRecordedOvertimeDurationEvaluation(evaluateOvertimePolicyPartDuration(definition(),policy()))).toBeNull();
    expect(parseRecordedOvertimeEvaluation(evaluateOvertimePattern(definition(),assigned()))?.assignmentId).toBe(uuid(5));
  });
  it('refuses mixed bindings, invalid dates, classifications, offsets and extra executable contract fields',()=>{
    const bad:unknown[]=[{...policy(),assignmentId:uuid(7)},{...policy(),policyBinding:undefined},
      ...[{kind:'assignment'},{revisionId:'not_a_revision'},{dayClass:'madeUp'},{dayOffset:3},{dayOffset:0},{calendarDate:'2024-02-30'},{extra:true}]
        .map(patch=>({...policy(),policyBinding:{...policy().policyBinding,...patch}}))];
    for(const input of bad){expect(()=>validateOvertimePolicyInput(input)).toThrow();const result=evaluateOvertimePolicyPart(definition(),input as never);expect(result.status).toBe('refused');expect(result.transferable).toBe(false);expect(result.assignmentId).toBeNull();}
  });
  it('requires a matching money classification and does not reinterpret final legacy quantities as policy evidence',()=>{
    const mismatch=policy();mismatch.policyBinding.dayClass='replacementHoliday';
    expect(evaluateOvertimePolicyPart(definition(),mismatch)).toMatchObject({status:'refused',transferable:false});
    const legacy={...policy(),layer:'finalLegacy',segments:[{id:'legacy',sessionId:'legacy_day',dayType:fact('workday'),clock:{state:'unknown',reason:'unrecordedPlacement'},finalMinutes:fact('120')}]};
    expect(()=>validateOvertimePolicyInput(legacy)).toThrow();expect(evaluateOvertimePolicyPart(definition(),legacy as never)).toMatchObject({status:'refused',transferable:false});
  });
  it.each(['pending','rejected','unknown'] as const)('retains %s approval refusal under the real policy identity',status=>{
    const input=policy();input.approval.status=status;
    const result=evaluateOvertimePolicyPart(definition(),input);expect(result).toMatchObject({status:'refused',transferable:false,assignmentId:null,policyBinding:input.policyBinding});
  });
  it('clones validated policy metadata and sanitizes invalid identities in refusals',()=>{
    const input=policy(),parsed=validateOvertimePolicyInput(input);parsed.policyBinding.dayClass='normal';expect(input.policyBinding.dayClass).toBe('off');
    const bad={...input,policyBinding:{...input.policyBinding,revisionId:'do_not_reflect_secret'}};
    const result=evaluateOvertimePolicyPart(definition(),bad as never);expect(result.status).toBe('refused');expect(JSON.stringify(result)).not.toContain('do_not_reflect_secret');
  });
  it('rejects mutated immutable policy identities and arithmetic rather than guessing a compatible assignment',()=>{
    const cash=evaluateOvertimePolicyPart(definition(),policy()),duration=evaluateOvertimePolicyPartDuration(definition(),policy());
    for(const patch of [{assignmentId:uuid(7)},{policyBinding:undefined},{policyBinding:{...policy().policyBinding,dayOffset:2}},{policyBinding:{...policy().policyBinding,revisionId:'not_a_revision'}},{extra:'unsupported'}]){
      expect(parseRecordedOvertimePolicyEvaluation({...cash,...patch})).toBeNull();
      expect(parseRecordedOvertimePolicyDurationEvaluation({...duration,...patch})).toBeNull();
    }
    expect(parseRecordedOvertimePolicyEvaluation({...cash,amountMinorUnits:'1'})).toBeNull();
    expect(parseRecordedOvertimePolicyDurationEvaluation({...duration,payableMinutes:{unit:'minutes',numerator:'121',denominator:'1'}})).toBeNull();
  });
});

function positionedPolicy(){
 const input=policy();if(input.layer!=='raw')throw Error('Raw fixture required');
 input.segments[0].clock=fact({startEpochSeconds:String(Date.parse(input.policyBinding.calendarDate+'T00:00:00+08:00')/1000),
  localDate:input.policyBinding.calendarDate,localStartSecond:0,elapsedSeconds:7200});return input;
}
function roundedCount(input:OvertimeInput<OvertimePolicyBinding>,minutes=30):OvertimePolicyRoundedCount{
 if(input.layer!=='raw'||input.segments[0].clock.state!=='known')throw Error('Original placed segment required');
 return {segmentId:input.segments[0].id,minutes,allocationPolicy:'earliest',source:{...input.source},
  policyBinding:{...input.policyBinding},anchor:{...input.segments[0].clock.value}};
}
describe('central pricing of finalized group-policy allocations',()=>{
 it('prices one approved-plan session with an independently shorter disjoint worked footprint',()=>{
  const input=positionedPolicy();if(input.layer!=='raw'||input.segments[0].clock.state!=='known')throw Error('Placed fixture');
  const segment=input.segments[0];if(segment.clock.state!=='known')throw Error('Placed plan fixture');const clock=segment.clock.value;
  segment.sessionId='approved_plan_union';segment.clock=fact({...clock},'approval');
  segment.rawMinutes=fact('120','approval');segment.approvedMinutes=fact('120','approval');
  const start=BigInt(clock.startEpochSeconds);
  const plan:OvertimePolicyApprovedPlanCount={basis:'approvedPlan',sessionBasis:'completeApprovedPlanUnion',durationDigest:'c'.repeat(64),
   source:{...input.source},policyBinding:{...input.policyBinding},selectedIntervals:[{fromEpochSeconds:String(start),toEpochSeconds:String(start+BigInt('7200'))}],
   plans:[{correctionId:uuid(30),workflowRequestId:uuid(31),fromEpochSeconds:String(start),toEpochSeconds:String(start+BigInt('5400'))},
    {correctionId:uuid(32),workflowRequestId:uuid(33),fromEpochSeconds:String(start+BigInt('3600')),toEpochSeconds:String(start+BigInt('7200'))}],
   workedDayIntervals:[{fromEpochMillisecond:Number(start-BigInt('3600'))*1000+555,toEpochMillisecond:Number(start-BigInt('3000'))*1000}]};
  const pattern=definition();pattern.rates[0].accumulation='session';
  const before=structuredClone({input,plan});
  expect(evaluateOvertimePolicyAllocatedPrice(pattern,input,[],plan)).toMatchObject({state:'proposed',minutes:120,amountMinorUnits:'3600',approvedPlanQuantity:plan});
  const forged=structuredClone(plan);forged.plans.pop();
  expect(evaluateOvertimePolicyAllocatedPrice(pattern,input,[],forged).state).toBe('unavailable');
  expect({input,plan}).toEqual(before);
 });

 it('retains the same exact rates, money rounding and immutable inputs without exposing a payable capability',()=>{
  const input=positionedPolicy(),pattern=definition(),before=structuredClone({input,pattern});
  const ordinary=evaluateOvertimePolicyPart(pattern,input),priced=evaluateOvertimePolicyAllocatedPrice(pattern,input);
  expect(priced).toMatchObject({state:'proposed',authority:'pricingProposalOnly',durationOwner:'attendanceGroupPolicy',minutes:120,amountMinorUnits:'3600'});
  if(priced.state!=='proposed'||ordinary.status==='refused')throw Error('Expected exact proposals');
  expect(priced.lines).toEqual(ordinary.lines);expect(Object.hasOwn(priced,'transferable')).toBe(false);
  expect(parseRecordedOvertimePolicyEvaluation(priced)).toBeNull();expect({input,pattern}).toEqual(before);
 });
 it('does not reapply central duration caps, rounding or minute deductions to the finalized group count',()=>{
  const pattern=definition(),input=positionedPolicy();
  pattern.eligibleMinutes={id:'legacy_eligible',unit:'minutes',type:'literal',value:'1'};
  pattern.durationCap={id:'legacy_cap',unit:'minutes',type:'literal',value:'2'};
  pattern.durationRounding={mode:'down',step:'30'};
  pattern.deductions=[{id:'legacy_break',resource:'postOtBreak',basis:'day',unit:'minutes',when:{id:'break_when',type:'constant',value:true},amount:{id:'break_amount',unit:'minutes',type:'literal',value:'30'}}];
  const before=structuredClone(pattern),result=evaluateOvertimePolicyAllocatedPrice(pattern,input);
  expect(result).toMatchObject({state:'proposed',minutes:120,amountMinorUnits:'3600',retainedDurationConfiguration:{minuteDeductionIds:['legacy_break']}});
  expect(pattern).toEqual(before);
 });
 it('keeps central monetary caps while leaving the finalized duration unchanged',()=>{
  const pattern=definition();pattern.paymentCap={id:'cash_cap',unit:'money',type:'literal',value:'10',currency:'MYR'};
  expect(evaluateOvertimePolicyAllocatedPrice(pattern,positionedPolicy())).toMatchObject({state:'proposed',minutes:120,amountMinorUnits:'1000'});
 });
 it('retains cross-unit conflict refusal when differently named resources share original source keys',()=>{
  const pattern=definition(),input=positionedPolicy();
  pattern.deductions=[
   {id:'minutes',resource:'postOtBreak',basis:'day',unit:'minutes',when:{id:'minutes_when',type:'constant',value:true},amount:{id:'minutes_amount',unit:'minutes',type:'literal',value:'30'}},
   {id:'money',resource:'lateIn',basis:'day',unit:'money',targetEarningItemId:uuid(20),when:{id:'money_when',type:'constant',value:true},amount:{id:'money_amount',unit:'money',type:'literal',value:'5',currency:'MYR'}}];
  input.resources=['postOtBreak','lateIn'].map(resource=>({id:resource,resource,evidence:'measured',basis:'day',sessionId:null,sourceKeys:['same_canonical_source'],measure:{unit:'minutes',quantity:fact('30')}}));
  expect(evaluateOvertimePolicyPart(pattern,input)).toMatchObject({status:'refused',issues:[{code:'deductionConflict'}]});
  expect(evaluateOvertimePolicyAllocatedPrice(pattern,input)).toMatchObject({state:'unavailable',reason:'formulaUnavailable'});
 });
 it('prices an explicitly attributed rounding quantity without changing its original clock or applying duration twice',()=>{
  const pattern=definition(),input=positionedPolicy();input.approval.minutes=fact('150','approval');
  pattern.durationRounding={mode:'down',step:'60'};pattern.durationCap={id:'old_duration_cap',unit:'minutes',type:'literal',value:'1'};
  const attribution=roundedCount(input),before=structuredClone({pattern,input,attribution});
  expect(evaluateOvertimePolicyAllocatedPrice(pattern,input,[attribution])).toMatchObject({state:'proposed',minutes:150,amountMinorUnits:'4500'});
  expect({pattern,input,attribution}).toEqual(before);
  expect(evaluateOvertimePolicyAllocatedPrice(pattern,input).state).toBe('unavailable');
  for(const changed of [{...attribution,minutes:31},{...attribution,anchor:{...attribution.anchor,elapsedSeconds:7201}},
   {...attribution,policyBinding:{...attribution.policyBinding,calendarDate:'2024-03-02'}},
   {...attribution,source:{...attribution.source,approvalDigest:'f'.repeat(64)}}])
   expect(evaluateOvertimePolicyAllocatedPrice(pattern,input,[changed]).state).toBe('unavailable');
  expect(evaluateOvertimePolicyAllocatedPrice(pattern,input,[attribution,attribution]).state).toBe('unavailable');
  pattern.paymentCap={id:'same_money_cap',type:'literal',unit:'money',currency:'MYR',value:'4'};
  expect(evaluateOvertimePolicyAllocatedPrice(pattern,input,[attribution])).toMatchObject({state:'proposed',minutes:150,amountMinorUnits:'400'});
 });
 it.each(['earliest','latest'] as const)('binds rounded money to the %s real rate slice across a time-band boundary',direction=>{
  const pattern=definition(),input=positionedPolicy();pattern.durationAllocation=direction;
  input.approval.minutes=fact('150','approval');
  const later=structuredClone(pattern.rates[0]);later.id='later_rate';later.priority=1;
  later.when.id='later_eligible';later.tiers[0].id='later_tier';
  if(later.tiers[0].payment.method!=='hourly')throw Error('Hourly fixture required');
  later.tiers[0].payment.multiplier.id='later_multiplier';
  later.timeBand={fromMinute:60,toMinute:120,endDayOffset:0};
  if(later.tiers[0].payment.method!=='hourly')throw Error('Hourly fixture required');
  later.tiers[0].payment.rate={id:'later_hourly',type:'literal',unit:'moneyPerHour',currency:'MYR',value:'24'};
  pattern.rates.push(later);const attribution={...roundedCount(input),allocationPolicy:direction};
  const before=structuredClone(input);
  expect(evaluateOvertimePolicyAllocatedPrice(pattern,input,[attribution])).toMatchObject({state:'proposed',minutes:150,
   amountMinorUnits:direction==='earliest'?'6300':'7200'});
  expect(input).toEqual(before);
 });
 it('refuses unplaced counts, unequal approval, changed formula eligibility and mixed resource units',()=>{
  const unknown=policy();expect(evaluateOvertimePolicyAllocatedPrice(definition(),unknown).state).toBe('unavailable');
  const partial=positionedPolicy();if(partial.layer!=='raw')throw Error('Raw required');partial.segments[0].approvedMinutes=fact('60','approval');
  expect(evaluateOvertimePolicyAllocatedPrice(definition(),partial).state).toBe('unavailable');
  const blocked=definition();blocked.eligibility={id:'blocked',type:'constant',value:false};
  expect(evaluateOvertimePolicyAllocatedPrice(blocked,positionedPolicy())).toMatchObject({state:'unavailable',reason:'durationChanged'});
  const conflict=definition();conflict.deductions=[
   {id:'minutes',resource:'postOtBreak',basis:'day',unit:'minutes',when:{id:'minutes_when',type:'constant',value:true},amount:{id:'minutes_amount',unit:'minutes',type:'literal',value:'30'}},
   {id:'money',resource:'postOtBreak',basis:'day',unit:'money',targetEarningItemId:uuid(20),when:{id:'money_when',type:'constant',value:true},amount:{id:'money_amount',unit:'money',type:'literal',value:'5',currency:'MYR'}}];
  expect(evaluateOvertimePolicyAllocatedPrice(conflict,positionedPolicy())).toMatchObject({state:'unavailable',reason:'formulaUnavailable'});
 });
});

function parentAllocations(){
 const parts=[0,1].map(offset=>{
  const input=positionedPolicy();if(input.layer!=='raw')throw Error('Raw fixture required');
  const calendarDate=offset===0?date:'2024-03-01';
  input.policyBinding={...input.policyBinding,dayClass:'normal',calendarDate,dayOffset:offset as 0|1};
  input.approval.minutes=fact('10','approval');input.facts.actualWorkingMinutes=fact('10');
  input.segments=[{...input.segments[0],id:'parent_part_'+offset,sessionId:'one_real_session',rawMinutes:fact('10'),approvedMinutes:fact('10','approval'),
   clock:fact({startEpochSeconds:String(Date.parse(calendarDate+(offset===0?'T23:50:00+08:00':'T00:00:00+08:00'))/1000),
    localDate:calendarDate,localStartSecond:offset===0?85800:0,elapsedSeconds:600})}];return input;
 });
 const parent:OvertimeInput<OvertimePolicyBinding>={...parts[0],facts:assigned().facts,segments:parts.flatMap(p=>p.layer==='raw'?p.segments:[]),
  approval:{...parts[0].approval,minutes:fact('20','approval')}};
 return {parts,parent};
}
function parentPrice(pattern:OvertimePattern,fixture=parentAllocations()){
 return evaluateOvertimePolicyAllocatedParentPrice(fixture.parent,fixture.parts.map(input=>({pattern,input})));
}
describe('one central parent money scope over dated allocations',()=>{
 it('keeps one parent monetary cap when a dated source owns a rounded count without extra physical work',()=>{
  const f=parentAllocations(),pattern=definition();f.parts[0].approval.minutes=fact('20','approval');
  f.parent.approval.minutes=fact('30','approval');
  pattern.paymentCap={id:'rounded_parent_cap',type:'literal',unit:'money',currency:'MYR',value:'7'};
  const before=structuredClone(f),rounded=roundedCount(f.parts[0],10);
  const result=evaluateOvertimePolicyAllocatedParentPrice(f.parent,f.parts.map((input,index)=>({pattern,input,
   roundedCounts:index===0?[rounded]:[]})));
  expect(result).toMatchObject({state:'proposed',amountMinorUnits:'700'});
  if(result.state!=='proposed')throw Error('Expected a single parent count/money proposal');
  expect(result.parts.map(part=>part.minutes)).toEqual([20,10]);
  expect(result.parts.reduce((n,part)=>n+BigInt(part.amountMinorUnits),BigInt('0'))).toBe(BigInt('700'));
  expect(f).toEqual(before);
 });
 it('prices explicit dated hourly expressions through one parent cap and refuses changed shared money rules',()=>{
  const f=parentAllocations(),first=definition(),second=structuredClone(first);f.parts[1].patternVersionId=uuid(99);
  const payment=second.rates[0].tiers[0].payment;
  if(payment.method!=='hourly'||payment.rate.type!=='literal')throw Error('Expected the actual hourly fixture');
  payment.rate.value='24';
  const parts=[{pattern:first,input:f.parts[0]},{pattern:second,input:f.parts[1]}],before=structuredClone({f,parts});
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,parts).state).toBe('unavailable');
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,parts,'identicalDefinitions').state).toBe('unavailable');
  const result=evaluateOvertimePolicyAllocatedParentPrice(f.parent,parts,'datedRateExpressions');
  expect(result).toMatchObject({state:'proposed',amountMinorUnits:'900'});
  if(result.state!=='proposed')throw Error('Expected explicit dated hourly proposals');
  expect(result.parts.map(part=>part.amountMinorUnits)).toEqual(['300','600']);
  expect(result.parts.every(part=>part.moneyScope.kind==='parent'&&part.moneyScope.formulaScope?.kind==='datedRateExpressions')).toBe(true);
  expect({f,parts}).toEqual(before);
  first.paymentCap=second.paymentCap={id:'common_dated_cap',type:'literal',unit:'money',currency:'MYR',value:'7'};
  const capped=evaluateOvertimePolicyAllocatedParentPrice(f.parent,parts,'datedRateExpressions');
  expect(capped).toMatchObject({state:'proposed',amountMinorUnits:'700'});
  if(capped.state!=='proposed')throw Error('Expected one shared cap');
  expect(capped.trace.filter(row=>row.id==='paymentCap')).toHaveLength(1);
  const altered=structuredClone(second);altered.paymentCap={...second.paymentCap,value:'8'};
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,[parts[0],{pattern:altered,input:f.parts[1]}],'datedRateExpressions').state).toBe('unavailable');
  const sameVersion={...f.parts[1],patternVersionId:f.parts[0].patternVersionId};
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,[parts[0],{pattern:second,input:sameVersion}],'datedRateExpressions').state).toBe('unavailable');
  const tierChange=structuredClone(second);tierChange.rates[0].accumulation='session';
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,[parts[0],{pattern:tierChange,input:f.parts[1]}],'datedRateExpressions').state).toBe('unavailable');
 });
 it('keeps incompatible dated formula caps and rounding under one parent without changing old shared scopes',()=>{
  const f=parentAllocations(),first=definition(),second=definition();f.parts[1].patternVersionId=uuid(99);
  first.paymentCap={id:'first_cap',type:'literal',unit:'money',currency:'MYR',value:'2'};
  second.paymentCap={id:'second_cap',type:'literal',unit:'money',currency:'MYR',value:'1'};
  second.moneyRounding.mode='down';second.rates[0].accumulation='session';
  const parts=[{pattern:first,input:f.parts[0]},{pattern:second,input:f.parts[1]}],before=structuredClone({f,parts});
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,parts,'datedRateExpressions').state).toBe('unavailable');
  const result=evaluateOvertimePolicyAllocatedParentPrice(f.parent,parts,'datedFormulaRules');
  expect(result).toMatchObject({state:'proposed',amountMinorUnits:'300'});
  if(result.state!=='proposed')throw Error('Expected independently scoped dated formula rules');
  expect(result.parts.map(p=>p.amountMinorUnits)).toEqual(['200','100']);
  expect(result.parts.every(p=>p.moneyScope.kind==='parent'&&p.moneyScope.formulaScope?.kind==='datedFormulaRules')).toBe(true);
  expect(result.trace.filter(row=>row.id==='paymentCap')).toHaveLength(2);
  const forged=structuredClone(parts);forged[1].input.patternVersionId=forged[0].input.patternVersionId;
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,forged,'datedFormulaRules').state).toBe('unavailable');
  expect({f,parts}).toEqual(before);
 });
 it.each(['day','session'] as const)('keeps one shared %s tier counter across distinct dated hourly expressions and rounded quantities',accumulation=>{
  const f=parentAllocations(),first=definition();f.parts[1].patternVersionId=uuid(99);
  const rate=first.rates[0];rate.accumulation=accumulation;rate.tiers[0].to='15';
  rate.tiers.push({...structuredClone(rate.tiers[0]),id:'tier_second',from:'15',to:null,
   payment:{method:'hourly',rate:{id:'hourly_second',type:'literal',unit:'moneyPerHour',currency:'MYR',value:'12'},
    multiplier:{id:'multiplier_second',type:'literal',unit:'scalar',value:'3'}}});
  const second=structuredClone(first);
  for(const tier of second.rates[0].tiers){
   if(tier.payment.method!=='hourly'||tier.payment.rate.type!=='literal')throw Error('Expected actual hourly tiers');
   tier.payment.rate.value='24';
  }
  const parts=[{pattern:first,input:f.parts[0]},{pattern:second,input:f.parts[1]}];
  // 10min @12x1.5 + 5min @24x1.5 + 5min @24x3. Resetting either
  // date's counter incorrectly yields 9.00 instead of the shared 12.00.
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,parts,'datedRateExpressions')).toMatchObject({state:'proposed',amountMinorUnits:'1200'});
  f.parts[1].approval.minutes=fact('20','approval');f.parent.approval.minutes=fact('30','approval');
  const rounded=roundedCount(f.parts[1],10),before=structuredClone(f);
  const result=evaluateOvertimePolicyAllocatedParentPrice(f.parent,[parts[0],{...parts[1],roundedCounts:[rounded]}],'datedRateExpressions');
  expect(result).toMatchObject({state:'proposed',amountMinorUnits:'2400'});
  if(result.state!=='proposed')throw Error('Expected one rounded dated-rate tier scope');
  expect(result.parts.map(part=>part.minutes)).toEqual([10,20]);expect(f).toEqual(before);
 });
 it('requires explicit identical-definition scope for different immutable versions and retains every dated version under one cap',()=>{
  const f=parentAllocations(),pattern=definition();f.parts[1].patternVersionId=uuid(99);
  pattern.paymentCap={id:'compatible_versions_cap',type:'literal',unit:'money',currency:'MYR',value:'4'};
  expect(parentPrice(pattern,f).state).toBe('unavailable'); // old absent scope keeps its refusal
  const before=structuredClone(f),parts=f.parts.map(input=>({pattern,input})),
   result=evaluateOvertimePolicyAllocatedParentPrice(f.parent,parts,'identicalDefinitions');
  expect(result).toMatchObject({state:'proposed',amountMinorUnits:'400'});
  if(result.state!=='proposed')throw Error('Expected one identical-definition scope');
  expect(result.parts.map(part=>part.patternVersionId)).toEqual([uuid(4),uuid(99)]);
  expect(result.parts.every(part=>part.moneyScope.kind==='parent'&&JSON.stringify(part.moneyScope.formulaScope)
   ===JSON.stringify({kind:'identicalDefinitions',partVersionIds:[uuid(4),uuid(99)]}))).toBe(true);
  expect(result.trace.filter(row=>row.id==='paymentCap')).toHaveLength(1);expect(f).toEqual(before);
  const changed=structuredClone(pattern);changed.moneyRounding.mode='down';
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,[{pattern,input:f.parts[0]},{pattern:changed,input:f.parts[1]}],'identicalDefinitions').state).toBe('unavailable');
  const wrongParent={...f.parent,patternVersionId:uuid(98)};
  expect(evaluateOvertimePolicyAllocatedParentPrice(wrongParent,parts,'identicalDefinitions').state).toBe('unavailable');
 });
 it('applies a cap once and keeps exact dated parts nontransferable proposals',()=>{
  const p=definition();p.paymentCap={id:'parent_cap',type:'literal',unit:'money',currency:'MYR',value:'4'};
  const f=parentAllocations(),before=structuredClone({p,f}),result=parentPrice(p,f);
  expect(result).toMatchObject({state:'proposed',authority:'parentPricingProposalOnly',amountMinorUnits:'400'});
  if(result.state!=='proposed')throw Error('Expected parent price');
  expect(result.parts.map(p=>p.amountMinorUnits)).toEqual(['200','200']);
  expect(result.parts.every(p=>p.moneyScope.kind==='parent'&&p.moneyScope.amountMinorUnits==='400')).toBe(true);
  expect(result.trace.filter(t=>t.id==='paymentCap')).toHaveLength(1);
  expect(Object.hasOwn(result,'transferable')).toBe(false);expect(parseRecordedOvertimePolicyEvaluation(result)).toBeNull();
  expect({p,f}).toEqual(before);
 });
 it('rounds one mapping total after combining half-cent dated lines',()=>{
  const p=definition(),payment=p.rates[0].tiers[0].payment;if(payment.method!=='hourly')throw Error('Hourly fixture');
  payment.rate={id:'half_cent_rate',type:'literal',unit:'moneyPerHour',currency:'MYR',value:'0.02'};
  const result=parentPrice(p);expect(result).toMatchObject({state:'proposed',amountMinorUnits:'1'});
  if(result.state!=='proposed')throw Error('Expected parent price');
  expect(result.parts.map(p=>p.amountMinorUnits).sort()).toEqual(['0','1']);
  expect(result.trace.filter(t=>t.kind==='rounding'&&t.id==='money')).toHaveLength(1);
 });
 it.each(['day','session'] as const)('retains one %s tier counter across midnight',accumulation=>{
  const p=definition(),first=p.rates[0].tiers[0];p.rates[0].accumulation=accumulation;
  if(first.payment.method!=='hourly')throw Error('Hourly fixture');
  first.to='10';first.payment.multiplier={id:'one_multiplier',type:'literal',unit:'scalar',value:'1'};
  p.rates[0].tiers.push({...structuredClone(first),id:'second_tier',from:'10',to:null,
   payment:{...first.payment,multiplier:{id:'second_multiplier',type:'literal',unit:'scalar',value:'1'},rate:{id:'next_rate',type:'literal',unit:'moneyPerHour',currency:'MYR',value:'24'}}});
  const result=parentPrice(p);expect(result).toMatchObject({state:'proposed',amountMinorUnits:'600'});
  if(result.state!=='proposed')throw Error('Expected parent price');expect(result.parts.map(p=>p.amountMinorUnits)).toEqual(['200','400']);
 });
 it.each(['day','session'] as const)('deduplicates a once-per-%s fixed charge across dated parts',basis=>{
  const p=definition();p.rates[0].tiers[0].payment={method:'flat',basis,chargeId:'one_charge',amount:{id:'charge_amount',type:'literal',unit:'money',currency:'MYR',value:'25'}};
  const result=parentPrice(p);expect(result).toMatchObject({state:'proposed',amountMinorUnits:'2500'});
  if(result.state!=='proposed')throw Error('Expected parent price');expect(result.trace.some(t=>t.kind==='charge'&&t.data.deduplicated===true)).toBe(true);
 });
 it('prices each segment from its dated salary while a parent cap uses canonical source-day facts',()=>{
  const p=definition(),f=parentAllocations();
  p.rates[0].tiers[0].payment={method:'hourly',rate:{id:'dated_rate',type:'hourlyRate',unit:'moneyPerHour',
   base:{id:'dated_base',type:'field',unit:'money',field:'basicSalary'},divisorMinutes:{id:'hour_divisor',type:'literal',unit:'minutes',value:'60'}},
   multiplier:{id:'salary_multiplier',type:'literal',unit:'scalar',value:'1'}};
  f.parts[0].facts.basicSalary=fact('12','payroll');f.parts[1].facts.basicSalary=fact('24','payroll');
  f.parent.facts.basicSalary=fact('4','payroll');
  expect(parentPrice(p,f)).toMatchObject({state:'proposed',amountMinorUnits:'600'});
  p.paymentCap={id:'source_day_cap',type:'field',unit:'money',field:'basicSalary'};
  expect(parentPrice(p,f)).toMatchObject({state:'proposed',amountMinorUnits:'400'});
 });
 it('consumes a shared monetary resource once across the complete parent',()=>{
  const p=definition(),f=parentAllocations();
  const r={id:'shared_resource',resource:'postOtBreak',evidence:'measured' as const,basis:'day' as const,sessionId:null,sourceKeys:['same_parent_source'],measure:{unit:'minutes' as const,quantity:fact('30')}};
  f.parent.resources=[r];for(const input of f.parts)input.resources=[r];
  p.deductions=[{id:'one_money_deduction',resource:'postOtBreak',basis:'day',unit:'money',targetEarningItemId:uuid(20),when:{id:'deduct_when',type:'constant',value:true},
   amount:{id:'deduct_amount',type:'literal',unit:'money',currency:'MYR',value:'1'}}];
  expect(parentPrice(p,f)).toMatchObject({state:'proposed',amountMinorUnits:'500'});
 });
 it('refuses incompatible versions, source substitution, incomplete parents and overlapping captures',()=>{
  const p=definition();
  for(const mutate of [
   (f:ReturnType<typeof parentAllocations>)=>{f.parts[1].patternVersionId=uuid(99);},
   (f:ReturnType<typeof parentAllocations>)=>{f.parts[1].source={...f.parts[1].source,inputDigest:'c'.repeat(64)};},
   (f:ReturnType<typeof parentAllocations>)=>{f.parent.segments=f.parent.segments.slice(0,1);},
   (f:ReturnType<typeof parentAllocations>)=>{f.parts[1]=structuredClone(f.parts[0]);},
   (f:ReturnType<typeof parentAllocations>)=>{f.parent.approval.minutes=fact('19','approval');},
  ]){const f=parentAllocations();mutate(f);expect(parentPrice(p,f).state).toBe('unavailable');}
  const f=parentAllocations(),changed=structuredClone(p);changed.moneyRounding.mode='down';
  expect(evaluateOvertimePolicyAllocatedParentPrice(f.parent,[{pattern:p,input:f.parts[0]},{pattern:changed,input:f.parts[1]}]).state).toBe('unavailable');
 });
});
