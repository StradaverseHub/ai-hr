/** A renderer guard, not formula validation or authorization. Malformed saved JSON must not crash an
 * editor or be silently replaced with a different policy. The canonical owner validates every write. */
import {OVERTIME_NUMERIC_FIELDS,OVERTIME_SELECTION_FIELDS,type OvertimePattern} from './overtime-pattern-model';
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
export function canRenderOvertimeDraft(value:unknown):value is OvertimePattern {
  let nodes=0;
  function object(value:unknown,depth:number):value is Record<string,unknown>{return ++nodes<=10000&&depth<=32&&record(value);}
  function expression(value:unknown,depth=0):boolean {
    if(!object(value,depth)||typeof value.id!=='string'||typeof value.unit!=='string')return false;
    switch(value.type){
      case 'literal':return typeof value.value==='string';
      case 'field':return typeof value.field==='string'&&Object.hasOwn(OVERTIME_NUMERIC_FIELDS,value.field);
      case 'ref':return typeof value.definitionId==='string';
      case 'if':return condition(value.when,depth+1)&&expression(value.then,depth+1)&&expression(value.else,depth+1);
      case 'add':case 'subtract':case 'multiply':case 'divide':case 'min':case 'max':return expression(value.left,depth+1)&&expression(value.right,depth+1);
      case 'cap':return expression(value.value,depth+1)&&expression(value.ceiling,depth+1);
      case 'hourlyRate':return expression(value.base,depth+1)&&expression(value.divisorMinutes,depth+1);
      case 'hourlyAmount':return expression(value.rate,depth+1)&&expression(value.minutes,depth+1);
      default:return false;
    }
  }
  function condition(value:unknown,depth=0):boolean {
    if(!object(value,depth)||typeof value.id!=='string')return false;
    switch(value.type){
      case 'constant':return typeof value.value==='boolean';
      case 'group':return (value.logic==='and'||value.logic==='or')&&Array.isArray(value.children)&&value.children.every(child=>condition(child,depth+1));
      case 'selection':case 'null':return typeof value.field==='string'&&(OVERTIME_SELECTION_FIELDS as readonly string[]).includes(value.field)&&(value.type==='null'?typeof value.isNull==='boolean':Array.isArray(value.values)&&value.values.every(item=>typeof item==='string'));
      case 'compare':return typeof value.operator==='string'&&expression(value.left,depth+1)&&expression(value.right,depth+1)&&(value.upper===undefined||expression(value.upper,depth+1));
      case 'clock':return (value.boundary==='start'||value.boundary==='end')&&typeof value.operator==='string'&&clock(value.value)&&(value.upper===undefined||clock(value.upper));
      default:return false;
    }
  }
  function clock(value:unknown){return record(value)&&Number.isInteger(value.dayOffset)&&Number.isInteger(value.minute);}
  const optionalExpression=(value:unknown)=>value===null||expression(value);
  if(!object(value,0)||value.v!==1||!record(value.currency)||typeof value.currency.code!=='string'||!Number.isInteger(value.currency.minorScale)||!['day','session'].includes(String(value.eligibilityBasis))||!condition(value.eligibility))return false;
  if(!Array.isArray(value.definitions)||!value.definitions.every(item=>record(item)&&typeof item.id==='string'&&expression(item.expression)))return false;
  if(!optionalExpression(value.eligibleMinutes)||!optionalExpression(value.durationCap)||!optionalExpression(value.paymentCap))return false;
  if(value.durationRounding!==null&&(!record(value.durationRounding)||typeof value.durationRounding.step!=='string'||typeof value.durationRounding.mode!=='string'))return false;
  if(!record(value.moneyRounding)||typeof value.moneyRounding.stage!=='string'||typeof value.moneyRounding.mode!=='string')return false;
  if(!Array.isArray(value.deductions)||!value.deductions.every(item=>record(item)&&typeof item.id==='string'&&typeof item.resource==='string'&&typeof item.basis==='string'&&typeof item.unit==='string'&&condition(item.when)&&expression(item.amount)))return false;
  if(!Array.isArray(value.rates)||!value.rates.every(rate=>{
    if(!record(rate)||typeof rate.id!=='string'||typeof rate.name!=='string'||typeof rate.description!=='string'||typeof rate.priority!=='number'||typeof rate.accumulation!=='string'||typeof rate.tierMode!=='string'||!condition(rate.when)||!Array.isArray(rate.tiers))return false;
    if(rate.timeBand!==null&&(!record(rate.timeBand)||!Number.isInteger(rate.timeBand.fromMinute)||!Number.isInteger(rate.timeBand.toMinute)||!Number.isInteger(rate.timeBand.endDayOffset)))return false;
    return rate.tiers.every(tier=>{if(!record(tier)||typeof tier.id!=='string'||typeof tier.from!=='string'||tier.to!==null&&typeof tier.to!=='string'||!record(tier.mapping)||typeof tier.mapping.earningItemId!=='string'||typeof tier.mapping.currency!=='string'||!record(tier.payment))return false;const payment=tier.payment;return payment.method==='hourly'?expression(payment.rate)&&expression(payment.multiplier):(payment.method==='flat'||payment.method==='formula')&&typeof payment.basis==='string'&&typeof payment.chargeId==='string'&&expression(payment.amount);});
  }))return false;
  return true;
}
