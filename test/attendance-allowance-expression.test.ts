import { describe, expect, it } from 'vitest';
import { evaluateAllowanceExpression, validateAllowanceExpression, type AllowanceExpression, type AllowanceExpressionCriterion, type AllowanceExpressionGroup } from '../lib/attendance-allowance-expression';
import { emptyAllowanceRules, emptyAllowanceRulesV3, evaluateAllowancePeriods, upgradeAllowanceRules, validateAllowanceRules, type AllowanceDay } from '../lib/attendance-allowance-rules';
import { todayInKualaLumpur } from '../lib/hr-date';
const year=Number(todayInKualaLumpur().slice(0,4))-1,date=`${year}-08-03`,month=date.slice(0,7);
const typeId='11111111-1111-4111-8111-111111111111',otherType='22222222-2222-4222-8222-222222222222';
const criterion=(id:string,field:AllowanceExpressionCriterion['field'],value='0',operator:AllowanceExpressionCriterion['operator']='eq',unit:AllowanceExpressionCriterion['unit']='occurrences'):AllowanceExpressionCriterion=>({id,type:'criterion',field,value,operator,unit});
const group=(logic:'and'|'or',children:AllowanceExpression[],id='root'):AllowanceExpressionGroup=>({id,type:'group',logic,children});
const day=(patch:Partial<AllowanceDay>={}):AllowanceDay=>({date,attendanceId:'attendance',kind:'full',shiftId:null,workingMinutes:480,actualMinutes:480,overtimeMinutes:0,lateMinutes:0,earlyOutMinutes:0,absentDays:0,attendanceDays:1,eligibleWorkingDays:1,complete:true,v3Facts:{shortMinutes:0,incomplete:false,fixedClockApplicable:true,leave:[],leaveTypesPresent:[],source:'canonical'},...patch});
const evaluate=(expression:AllowanceExpression,days=[day()])=>evaluateAllowanceExpression(expression,days);
describe('grouped allowance decisions',()=>{
  it('preserves nested All/Any grouping which a flat expression cannot represent',()=>{
    const a=criterion('a','lateCount','0'),b=criterion('b','absenceCount','0'),c=criterion('c','attendanceDays','2','gte','days');
    expect(evaluate(group('and',[a,group('or',[b,c],'inner')])).state).toBe('true');
    expect(evaluate(group('and',[a,b,c])).state).toBe('false');
    const reordered=group('and',[group('or',[c,b],'inner'),a]);
    expect(evaluate(reordered).state).toBe('true');
    expect(validateAllowanceExpression(JSON.parse(JSON.stringify(reordered)))).toEqual(reordered);
  });
  it('uses three-state truth: false wins All, true wins Any, and only otherwise propagates Unknown',()=>{
    const unknown=criterion('u','actualMinutes','1','gt','hours'),yes=criterion('yes','absenceCount'),no=criterion('no','attendanceDays','2','gte','days'),days=[day({actualMinutes:null})];
    expect(evaluate(group('and',[unknown,no]),days).state).toBe('false');
    expect(evaluate(group('and',[unknown,yes]),days).state).toBe('unknown');
    expect(evaluate(group('or',[unknown,yes]),days).state).toBe('true');
    expect(evaluate(group('or',[unknown,no]),days).state).toBe('unknown');
  });
  it('separates occurrence counts, day fractions and durations and never counts repeated dates twice',()=>{
    const days=[day({lateMinutes:15,earlyOutMinutes:4,absentDays:0.5}),day({date:`${year}-08-04`,lateMinutes:5,absentDays:0.25})];
    const trace=evaluate(group('and',[criterion('late','lateCount','2'),criterion('duration','lateMinutes','20','eq','minutes'),criterion('absentCount','absenceCount','2'),criterion('absence','absentDays','0.75','eq','days')]),days);
    expect(trace.state).toBe('true');
    expect(()=>evaluate(group('and',[]),[day(),day()])).toThrow('Duplicate canonical allowance date');
  });
  it('allows known incomplete counts while leaving required work duration Unknown; v2 behavior stays strict',()=>{
    const incomplete=day({complete:false,actualMinutes:null,v3Facts:{...day().v3Facts!,incomplete:true,shortMinutes:null}}),rules=emptyAllowanceRulesV3();
    rules.attendance.expression=group('and',[criterion('i','incompleteCount','1')]);
    const input={method:'daily' as const,month,amount:'10.05',effectiveFrom:`${year}-01-01`,today:`${year}-12-31`,days:[incomplete]};
    expect(evaluateAllowancePeriods({...input,rules}).find(period=>period.from===date)?.amount).toBe('10.05');
    expect(evaluateAllowancePeriods({...input,rules:emptyAllowanceRules()}).find(period=>period.from===date)?.reasons).toContain('incompleteAttendance');
    rules.attendance.expression=group('and',[criterion('work','actualMinutes','0','eq','minutes')]);
    expect(evaluateAllowancePeriods({...input,rules}).find(period=>period.from===date)?.reasons).toContain('unknownMeasurements');
  });
  it('treats fixed-clock lateness as inapplicable for Full Flexi rather than inventing it from missing minutes',()=>{
    const days=[day({lateMinutes:null,earlyOutMinutes:null,v3Facts:{...day().v3Facts!,fixedClockApplicable:false}})];
    expect(evaluate(group('and',[criterion('late','lateCount'),criterion('early','earlyOutMinutes','0','eq','minutes')]),days).state).toBe('true');
    expect(evaluate(group('and',[criterion('late','lateCount')]),[day({lateMinutes:null})]).state).toBe('unknown');
  });
  it('counts approved leave by distinct date and type, sums approved fractions, and keeps ambiguous duration Unknown',()=>{
    const facts={...day().v3Facts!,leave:[{typeId,paid:true,days:0.5,requestIds:['request-1']},{typeId:otherType,paid:false,days:0.5,requestIds:['request-2']}],leaveTypesPresent:[typeId,otherType]},days=[day({v3Facts:facts})];
    expect(evaluate(group('and',[criterion('count','leaveCount','1'),criterion('duration','leaveDays','1','eq','days')]),days).state).toBe('true');
    expect(evaluate(group('and',[{...criterion('chosen','leaveDays','0.5','eq','days'),leaveTypeIds:[typeId]}]),days).state).toBe('true');
    const ambiguous=[day({v3Facts:{...facts,leave:null}})];
    expect(evaluate(group('and',[criterion('knownCount','leaveCount','1')]),ambiguous).state).toBe('true');
    expect(evaluate(group('and',[criterion('unknownDuration','leaveDays','0','eq','days')]),ambiguous).state).toBe('unknown');
  });
  it('compares exact hour thresholds and inclusive bounds with every operator',()=>{
    for(const [operator,value,expected] of [['eq','0.1','true'],['ne','0.1','false'],['gt','0.09','true'],['gte','0.1','true'],['lt','0.11','true'],['lte','0.1','true']] as const){
      expect(evaluate(group('and',[criterion('time','lateMinutes',value,operator,'hours')]),[day({lateMinutes:6})]).state).toBe(expected);
    }
    expect(evaluate(group('and',[{...criterion('time','lateMinutes','0.09','between','hours'),upper:'0.1'}]),[day({lateMinutes:6})]).state).toBe('true');
  });
  it('refuses incomplete, mismatched, duplicate, empty nested and oversized definitions at the service validator',()=>{
    const valid=criterion('a','lateCount');
    for(const bad of [{...valid,value:'0.5'},{...valid,unit:'hours'},{...valid,upper:'1'},{...valid,operator:'between',value:'2',upper:'1'},{...valid,leaveTypeIds:[typeId]},{...valid,value:'1e3'}])expect(()=>validateAllowanceExpression(group('and',[bad as AllowanceExpression]))).toThrow();
    expect(()=>validateAllowanceExpression(group('and',[valid,valid]))).toThrow();
    expect(()=>validateAllowanceExpression(group('and',[group('or',[],'empty')]))).toThrow();
    expect(()=>validateAllowanceExpression(group('and',Array.from({length:31},(_,i)=>({...valid,id:String(i)}))))).toThrow();
    let tree:AllowanceExpression=valid;for(let depth=0;depth<8;depth++)tree=group('and',[tree],`group${depth}`);
    expect(()=>validateAllowanceExpression(tree)).toThrow();
    expect(validateAllowanceRules(emptyAllowanceRulesV3())).toEqual(emptyAllowanceRulesV3());
  });
  it('converts flat rules only on explicit new-version creation and preserves the old object and ordered comparisons',()=>{
    const old=emptyAllowanceRules();old.attendance.logic='or';old.attendance.criteria=[{field:'lateMinutes',operator:'lte',value:'0.5',unit:'hours'},{field:'attendanceDays',operator:'gte',value:'20',unit:'days'}];
    const saved=JSON.stringify(old),next=upgradeAllowanceRules(old);expect(JSON.stringify(old)).toBe(saved);
    expect(next.v).toBe(3);expect(next.attendance.expression).toMatchObject({logic:'or',children:old.attendance.criteria});
    expect(validateAllowanceRules(next)).toEqual(next);
  });
});
