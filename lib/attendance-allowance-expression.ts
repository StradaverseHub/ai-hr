/** Version 3 allowance expressions. Counts, measurements and unknown facts remain distinct. */
import { ALLOWANCE_METRICS, ALLOWANCE_OPERATORS, type AllowanceMetric, type AllowanceOperator } from './attendance-allowance-vocabulary';
import type { AllowanceDay } from './attendance-allowance-rules';
export const ALLOWANCE_METRICS_V3=[...ALLOWANCE_METRICS,'lateCount','earlyOutCount','absenceCount','shortHoursCount','shortMinutes','incompleteCount','leaveCount','leaveDays'] as const;
export type AllowanceMetricV3=typeof ALLOWANCE_METRICS_V3[number];
export type AllowanceExpressionUnit='minutes'|'hours'|'days'|'occurrences';
export type AllowanceExpressionCriterion={id:string;type:'criterion';field:AllowanceMetricV3;operator:AllowanceOperator;value:string;upper?:string;unit:AllowanceExpressionUnit;leaveTypeIds?:string[]};
export type AllowanceExpressionGroup={id:string;type:'group';logic:'and'|'or';children:AllowanceExpression[]};
export type AllowanceExpression=AllowanceExpressionCriterion|AllowanceExpressionGroup;
export type AllowanceTruth='true'|'false'|'unknown';
export type AllowanceExpressionTrace={id:string;type:'group';logic:'and'|'or';state:AllowanceTruth;children:AllowanceExpressionTrace[]}|(AllowanceExpressionCriterion&{state:AllowanceTruth;actual:number|null;actualUnit:'minutes'|'days'|'occurrences';reason?:'unknownMeasurement'});
const COUNT_FIELDS=new Set<AllowanceMetricV3>(['lateCount','earlyOutCount','absenceCount','shortHoursCount','incompleteCount','leaveCount']);
export const allowanceExpressionUnit=(field:AllowanceMetricV3):'minutes'|'days'|'occurrences'=>COUNT_FIELDS.has(field)?'occurrences':field.endsWith('Minutes')?'minutes':'days';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fixed(value:unknown,unit:AllowanceExpressionUnit):bigint {
 if(typeof value!=='string'||!/^\d{1,8}(?:\.\d{1,2})?$/.test(value)||unit==='occurrences'&&!/^\d+$/.test(value))throw new Error('Enter a complete threshold in the measure’s unit.');
 const [whole,fraction='']=value.split('.'),hundredths=BigInt(whole)*BigInt(100)+BigInt(fraction.padEnd(2,'0'));
 return unit==='hours'?hundredths*BigInt(60):hundredths;
}
export function validateAllowanceExpression(raw:unknown):AllowanceExpression {
 let count=0;const seen=new Set<string>();
 function visit(value:unknown,depth:number):AllowanceExpression {
  if(depth>6||++count>120||!value||typeof value!=='object'||Array.isArray(value))throw new Error('Allowance conditions exceed the supported depth or size.');
  const node=value as Record<string,unknown>;
  if(typeof node.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(node.id)||seen.has(node.id))throw new Error('Condition identifiers must be unique and stable.');seen.add(node.id);
  const allowed=node.type==='group'?['id','type','logic','children']:['id','type','field','operator','value','upper','unit','leaveTypeIds'];
  if(Object.keys(node).some(key=>!allowed.includes(key)))throw new Error('Unsupported condition property.');
  if(node.type==='group'){
   if(!['and','or'].includes(String(node.logic))||!Array.isArray(node.children)||node.children.length>30||depth>0&&!node.children.length)throw new Error('Each nested group needs conditions and an All or Any choice.');
   return {id:node.id,type:'group',logic:node.logic as 'and'|'or',children:node.children.map(child=>visit(child,depth+1))};
  }
  if(node.type!=='criterion'||!ALLOWANCE_METRICS_V3.includes(node.field as AllowanceMetricV3)||!ALLOWANCE_OPERATORS.includes(node.operator as AllowanceOperator))throw new Error('Unsupported attendance measure or comparison.');
  const field=node.field as AllowanceMetricV3,unit=node.unit as AllowanceExpressionUnit,expected=allowanceExpressionUnit(field);
  if(expected==='minutes'?!['minutes','hours'].includes(unit):unit!==expected)throw new Error('The threshold unit does not match its measure.');
  const low=fixed(node.value,unit);
  if(node.operator==='between'&&fixed(node.upper,unit)<low)throw new Error('Between requires an upper threshold at or above the lower threshold.');
  if(node.operator!=='between'&&node.upper!==undefined)throw new Error('Only Between accepts an upper threshold.');
  const leave=field==='leaveCount'||field==='leaveDays';
  if(node.leaveTypeIds!==undefined&&(!leave||!Array.isArray(node.leaveTypeIds)||node.leaveTypeIds.length>100||node.leaveTypeIds.some(id=>typeof id!=='string'||!UUID.test(id))))throw new Error('Choose valid leave types for a leave measure.');
  return {id:node.id,type:'criterion',field,operator:node.operator as AllowanceOperator,value:node.value as string,unit,...(node.operator==='between'?{upper:node.upper as string}:{}),...(leave?{leaveTypeIds:[...new Set(node.leaveTypeIds as string[]??[])]}:{})};
 }
 const expression=visit(raw,0);if(expression.type!=='group')throw new Error('Allowance conditions need a root group.');return expression;
}
/** One canonical date contributes at most one occurrence. A missing time measurement is never zero. */
function actualFor(criterion:AllowanceExpressionCriterion,days:AllowanceDay[]):number|null {
 const values=days.map(day=>{
  const facts=day.v3Facts,field=criterion.field;
  if(field==='lateCount'||field==='earlyOutCount'){
   if(facts?.fixedClockApplicable===false)return 0;
   const minutes=field==='lateCount'?day.lateMinutes:day.earlyOutMinutes;
   return minutes==null?null:minutes>0?1:0;
  }
  if(field==='absenceCount')return day.absentDays>0?1:0;
  if(field==='incompleteCount')return facts?facts.incomplete?1:0:null;
  if(field==='shortHoursCount')return !day.complete?0:facts?.shortMinutes==null?null:facts.shortMinutes>0?1:0;
  if(field==='shortMinutes')return facts?.shortMinutes??null;
  if(field==='leaveCount'||field==='leaveDays'){
   if(!facts)return null;
   const selected=criterion.leaveTypeIds??[];
   if(field==='leaveCount')return facts.leaveTypesPresent.some(id=>!selected.length||selected.includes(id))?1:0;
   if(facts.leave==null)return null;
   const total=facts.leave.filter(row=>!selected.length||selected.includes(row.typeId)).reduce((sum,row)=>sum+row.days,0);
   if(!Number.isFinite(total)||total<0||total>1.000001)throw new Error('Inconsistent canonical leave fractions.');
   return field==='leaveCount'?total>0?1:0:total;
  }
  if((field==='lateMinutes'||field==='earlyOutMinutes')&&facts?.fixedClockApplicable===false)return 0;
  return day[field as AllowanceMetric];
 });
 return values.some(value=>value==null)?null:values.reduce<number>((sum,value)=>sum+(value??0),0);
}
export function evaluateAllowanceExpression(expression:AllowanceExpression,days:AllowanceDay[]):AllowanceExpressionTrace {
 const root=validateAllowanceExpression(expression);
 if(new Set(days.map(day=>day.date)).size!==days.length)throw new Error('Duplicate canonical allowance date.');
 function evaluate(node:AllowanceExpression):AllowanceExpressionTrace {
  if(node.type==='group'){
   const children=node.children.map(evaluate);
   const state:AllowanceTruth=!children.length?'true':node.logic==='and'?children.some(c=>c.state==='false')?'false':children.some(c=>c.state==='unknown')?'unknown':'true':children.some(c=>c.state==='true')?'true':children.some(c=>c.state==='unknown')?'unknown':'false';
   return {id:node.id,type:'group',logic:node.logic,state,children};
  }
  const actual=actualFor(node,days),value=actual==null?null:BigInt(Math.round(actual*100)),low=fixed(node.value,node.unit),high=node.operator==='between'?fixed(node.upper,node.unit):low;
  const pass=value!=null&&(node.operator==='eq'?value===low:node.operator==='ne'?value!==low:node.operator==='gt'?value>low:node.operator==='gte'?value>=low:node.operator==='lt'?value<low:node.operator==='lte'?value<=low:value>=low&&value<=high);
  return {...node,actual,actualUnit:allowanceExpressionUnit(node.field),state:actual==null?'unknown':pass?'true':'false',...(actual==null?{reason:'unknownMeasurement' as const}:{})};
 }
 return evaluate(root);
}
export function allowanceExpressionCriteria(node:AllowanceExpression):AllowanceExpressionCriterion[]{return node.type==='criterion'?[node]:node.children.flatMap(allowanceExpressionCriteria);}
