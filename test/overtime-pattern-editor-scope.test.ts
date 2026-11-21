/** b31981c0: the simplified Overtime Patterns editor may change only identity text and eligibility. These pure checks
 * prove that the server-side merge keeps every hidden calculation value of an existing pattern, so evaluator money,
 * payable duration (the TOIL input) and the Payroll lines built from them are byte-identical after an edit. */
import {describe,expect,it} from 'vitest';
import {evaluateOvertimePattern,evaluateOvertimePatternDuration} from '../lib/overtime-pattern-evaluate';
import {validateOvertimePattern,validateOvertimePatternDraft} from '../lib/overtime-pattern-schema';
import {OvertimePatternError,type OvertimeCondition,type OvertimeEvaluation,type OvertimeExpression,type OvertimeFact,type OvertimeInput,type OvertimePattern,type OvertimeUnit} from '../lib/overtime-pattern-model';
import {blankOvertimePattern,overtimeEditorBase,overtimeEditorCurrency,overtimeEditorDefinition,OVERTIME_EDITOR_DEFINITION_FIELDS} from '../lib/overtime-pattern-editor-scope';
import {overtimeStarterSeed,prepareOvertimeStarter} from '../lib/overtime-pattern-starters';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const date='2026-03-02',currency={code:'MYR',minorScale:2};
const fact=<T>(value:T,owner:'attendance'|'approval'|'personnel'|'payroll'='attendance'):OvertimeFact<T>=>({state:'known',value,provenance:{owner,reference:`recorded_${owner}`,asOf:date,basis:'recorded'}});
const missing=<T>():OvertimeFact<T>=>({state:'unknown',reason:'unrecordedHistoricalFact'});
const literal=(id:string,unit:OvertimeUnit,value:string):OvertimeExpression=>({id,type:'literal',unit,value,...(unit==='money'||unit==='moneyPerHour'?{currency:'MYR'}:{})});
const yes=(id:string):OvertimeCondition=>({id,type:'constant',value:true});

/** An existing fictional pattern that uses every hidden axis: latest allocation, a deduction, duration rounding,
 * a tiered hourly rate with an earning mapping and day-mapping money rounding. */
function existing():OvertimePattern {
 return {v:1,currency:{...currency},definitions:[],eligibilityBasis:'day',durationAllocation:'latest',eligibility:yes('eligible'),
  eligibleMinutes:null,durationCap:null,durationRounding:{step:'30',mode:'down'},
  deductions:[{id:'break_deduction',resource:'postOtBreak',basis:'day',unit:'minutes',when:yes('deduction_when'),amount:literal('deduction_amount','minutes','30')}],
  rates:[{id:'rate',name:'Fictional configured rate',description:'Synthetic regression policy',priority:0,when:yes('rate_when'),timeBand:null,accumulation:'day',tierMode:'marginal',
   tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:uuid(20),currency:'MYR'},payment:{method:'hourly',rate:literal('rate_value','moneyPerHour','12'),multiplier:literal('rate_multiplier','scalar','1.5')}}]}],
  paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};
}
function input():OvertimeInput {
 const clock=(localStart:number,elapsed:number)=>fact({startEpochSeconds:String(Date.parse(date+'T00:00:00Z')/1000+localStart-8*3600),localDate:date,localStartSecond:localStart,elapsedSeconds:elapsed});
 return {mode:'actual',sessionGranularity:'recorded',layer:'raw',source:{tenantId:uuid(1),employmentId:uuid(2),attendanceId:uuid(3),date,inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},patternVersionId:uuid(4),assignmentId:uuid(5),currency:{...currency},
  facts:{employmentId:fact(uuid(2),'personnel'),companyId:fact(uuid(10),'personnel'),dayType:fact('workday'),actualWorkingMinutes:fact('120'),requiredWorkingMinutes:fact('0'),lateMinutes:fact('15'),basicSalary:fact('3000','payroll')},
  resources:[{id:'break_resource',resource:'postOtBreak',evidence:'policyCapacity',basis:'day',sessionId:null,sourceKeys:['canonical_break'],measure:{unit:'minutes',quantity:fact('120')}}],
  approval:{status:'approved',minutes:fact('90','approval'),provenance:{owner:'approval',reference:uuid(6),asOf:date,basis:'recorded'}},
  segments:[{id:'segment_1',sessionId:'session_1',dayType:fact('workday'),clock:clock(9*3600,3600),rawMinutes:fact('60'),approvedMinutes:fact('60','approval')},
   {id:'segment_2',sessionId:'session_2',dayType:fact('workday'),clock:clock(18*3600,3600),rawMinutes:fact('60'),approvedMinutes:fact('60','approval')}]};
}
/** What a stale or tampered browser could still post for the hidden fields. */
function tamperedBrowserDefinition(eligibility:OvertimeCondition):Record<string,unknown> {
 return {...blankOvertimePattern({code:'SGD',minorScale:2}),eligibilityBasis:'session',durationAllocation:'earliest',durationRounding:null,deductions:[],
  rates:[{...existing().rates[0],tiers:[{...existing().rates[0].tiers[0],payment:{method:'hourly',rate:literal('tampered_rate','moneyPerHour','999'),multiplier:literal('tampered_multiplier','scalar','9')}}]}],eligibility};
}
function ready(result:OvertimeEvaluation) {expect(result.status).toBe('ready');if(result.status==='refused')throw new Error(JSON.stringify(result.issues));return result;}

describe('server-owned hidden Overtime Pattern values (b31981c0)',()=>{
 it('exposes eligibility as the only browser-editable definition field',()=>{
  expect(OVERTIME_EDITOR_DEFINITION_FIELDS).toEqual(['eligibility']);
 });
 it('keeps money, payable duration and Payroll lines identical after an editor save of an existing pattern',()=>{
  const saved=existing(),before=structuredClone(saved);
  const original=ready(evaluateOvertimePattern(saved,input())),originalDuration=evaluateOvertimePatternDuration(saved,input());
  // Non-empty, independently expected result, so equality below is not two empty answers.
  expect(`${original.payableMinutes.numerator}/${original.payableMinutes.denominator}`).toBe('60/1');
  expect(original.lines.map(line=>line.segmentId)).toEqual(['segment_2']);expect(original.amountMinorUnits).toBe('1800');
  expect(originalDuration.status).toBe('ready');
  const merged=validateOvertimePattern(overtimeEditorDefinition(overtimeEditorBase(saved),tamperedBrowserDefinition(structuredClone(saved.eligibility)),'SGD'));
  expect(saved).toEqual(before);
  expect(JSON.stringify(merged)).toBe(JSON.stringify(validateOvertimePattern(before)));
  expect(evaluateOvertimePattern(merged,input())).toEqual(original);
  expect(evaluateOvertimePatternDuration(merged,input())).toEqual(originalDuration);
  // Counterfactual: if the browser's hidden values were trusted, the result would change.
  const trusted=validateOvertimePatternDraft(tamperedBrowserDefinition(structuredClone(saved.eligibility)));
  expect(evaluateOvertimePattern({...trusted,currency:{...currency}},input())).not.toEqual(original);
 });
 it('takes only eligibility from the browser and never overwrites a non-blank saved currency',()=>{
  const saved={...existing(),currency:{code:'SGD',minorScale:2}},edited:OvertimeCondition={id:'edited',type:'selection',field:'dayType',operator:'in',values:['rest_day']};
  const merged=overtimeEditorDefinition(overtimeEditorBase(saved),tamperedBrowserDefinition(edited),'MYR');
  expect(merged.eligibility).toEqual(edited);
  const {eligibility:_mergedEligibility,...mergedHidden}=merged,{eligibility:_savedEligibility,...savedHidden}=saved;
  expect(mergedHidden).toEqual(savedHidden);expect(merged.currency).toEqual({code:'SGD',minorScale:2});
 });
 it('fills only a blank currency from the owning company with its canonical precision',()=>{
  const saved={...existing(),currency:{code:'',minorScale:0}};
  expect(overtimeEditorDefinition(saved,{eligibility:saved.eligibility},'JPY').currency).toEqual({code:'JPY',minorScale:0});
  expect(overtimeEditorDefinition(saved,{eligibility:saved.eligibility},'MYR').currency).toEqual({code:'MYR',minorScale:2});
  expect(overtimeEditorDefinition(saved,{eligibility:saved.eligibility},undefined).currency).toEqual({code:'',minorScale:0});
  expect(overtimeEditorCurrency('NOT-A-CURRENCY')).toEqual({code:'',minorScale:0});
 });
 it('uses the existing editor defaults for a new or seeded draft and never the browser values',()=>{
  expect(overtimeEditorBase(null)).toEqual(blankOvertimePattern());
  expect(blankOvertimePattern()).toMatchObject({eligibilityBasis:'day',durationAllocation:'earliest',rates:[],currency:{code:'',minorScale:0}});
  expect(overtimeEditorBase(null,'ot30')).toEqual(prepareOvertimeStarter('ot30','day','earliest'));
  expect(overtimeEditorBase(overtimeStarterSeed('ot00'))).toEqual(prepareOvertimeStarter('ot00','day','earliest'));
  const merged=overtimeEditorDefinition(overtimeEditorBase(null,'ot15'),tamperedBrowserDefinition(yes('browser')),'MYR');
  expect(merged).toMatchObject({eligibilityBasis:'day',durationAllocation:'earliest',currency:{code:'MYR',minorScale:2},deductions:[]});
  expect(merged.rates).toEqual(prepareOvertimeStarter('ot15','day','earliest').rates);
  expect(validateOvertimePatternDraft(merged).eligibility).toEqual(yes('browser'));
 });
 it.each([null,'text',[],{rates:[]}])('refuses a posted definition without eligibility (%j)',posted=>{
  expect(()=>overtimeEditorDefinition(existing(),posted,'MYR')).toThrow(OvertimePatternError);
 });
});
