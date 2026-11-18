/** Model proposals use only the documented single-value subset. The canonical validator owns all bounds. */
import { validatePayRule, type PayRule } from '../../core/pay-rule';
const fields:Readonly<Record<string,readonly string[]>>={
 fixed:['kind'],percent_of:['base','kind','pct'],per_day:['kind','rate'],per_hour:['kind','rate'],
 flat_capped:['cap','kind','value'],qty_rate:['kind','qty','rate'],
};
export function adjudicateAiPayRule(value:unknown,prorates:boolean):{ok:true;rule:PayRule}|{ok:false;reason:string}{
 if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,reason:'no_rule_in_output'};
 const row=value as Record<string,unknown>,keys=typeof row.kind==='string'&&Object.hasOwn(fields,row.kind)?fields[row.kind]:undefined;
 if(!keys||Object.keys(row).sort().join(',')!==keys.join(',')||row.kind==='percent_of'&&row.base!=='basic')return {ok:false,reason:'unsupported_model_rule'};
 const rule=value as PayRule,checked=validatePayRule(rule,prorates);
 return checked.ok?{ok:true,rule}:{ok:false,reason:`validate_pay_rule:${checked.code}`};
}
