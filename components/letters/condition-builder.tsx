'use client';
import {useId} from 'react';
import {CURRENCIES} from '@/lib/currencies';
import type {LetterCondition,LetterField,LetterValue} from '@/lib/letter-model';
import {inputCls} from '@/components/ui';

export type ConditionLabels={operator:string;field:string;value:string;currency:string;present:string;equals:string;after:string;greater:string;all:string;any:string;not:string;add:string;remove:string};
const control=`${inputCls} min-h-11`;
/** Values are explicit typed operands. Empty inputs remain invalid until the author corrects them. */
export function LetterConditionBuilder({condition,fields,onChange,labels,depth=0}:{condition:LetterCondition;fields:LetterField[];onChange:(value:LetterCondition)=>void;labels:ConditionLabels;depth?:number}){
 const id=useId(),first=fields[0]?.key??'',leaf='field' in condition?condition.field:first,definition=fields.find(field=>field.key===leaf);
 const operators:LetterCondition['type'][]=['present','equals',...(definition?.kind==='date'?['after' as const]:[]),...(definition?.kind==='currency'?['greater' as const]:[]),...(depth<8?['all' as const,'any' as const,'not' as const]:[])];
 // Keep a loaded deeper condition visible; the author can simplify it without silently losing it.
 if(!operators.includes(condition.type))operators.push(condition.type);
 const emptyValue=(field:LetterField|undefined):LetterValue=>field?.kind==='currency'?{kind:'currency',value:'',currency:''}:field?.kind==='date'?{kind:'date',value:''}:{kind:'text',value:''};
 function changeType(type:LetterCondition['type']){
  if(type==='all'||type==='any')onChange({type,conditions:condition.type==='all'||condition.type==='any'?condition.conditions:[condition]});
  else if(type==='not')onChange({type,condition});
  else if(type==='present')onChange({type,field:leaf});
  else onChange({type,field:leaf,value:'value' in condition?condition.value:emptyValue(definition)});
 }
 return <div className="space-y-3 rounded-md border p-3">
  <label className="block space-y-1 text-sm" htmlFor={`${id}-operator`}><span>{labels.operator}</span><select id={`${id}-operator`} className={control} value={condition.type} onChange={event=>changeType(event.target.value as LetterCondition['type'])}>{operators.map(type=><option key={type} value={type}>{labels[type]}</option>)}</select></label>
  {'conditions' in condition?<div className="space-y-3">{condition.conditions.map((child,index)=><div key={index} className="space-y-2"><LetterConditionBuilder condition={child} fields={fields} labels={labels} depth={depth+1} onChange={value=>onChange({...condition,conditions:condition.conditions.map((item,position)=>position===index?value:item)})}/><button type="button" className="min-h-11 rounded border px-3 text-sm disabled:opacity-50" disabled={condition.conditions.length===1} onClick={()=>onChange({...condition,conditions:condition.conditions.filter((_,position)=>position!==index)})}>{labels.remove}</button></div>)}<button type="button" className="min-h-11 rounded border px-3 text-sm disabled:opacity-50" disabled={condition.conditions.length>=20||!first} onClick={()=>onChange({...condition,conditions:[...condition.conditions,{type:'present',field:first}]})}>{labels.add}</button></div>
  :condition.type==='not'?<LetterConditionBuilder condition={condition.condition} fields={fields} labels={labels} depth={depth+1} onChange={value=>onChange({...condition,condition:value})}/>
  :<><label className="block space-y-1 text-sm" htmlFor={`${id}-field`}><span>{labels.field}</span><select id={`${id}-field`} className={control} value={condition.field} onChange={event=>{const field=fields.find(item=>item.key===event.target.value);onChange(condition.type==='present'?{type:'present',field:event.target.value}:{type:'equals',field:event.target.value,value:emptyValue(field)});}}>{fields.map(field=><option key={field.key} value={field.key}>{field.label}</option>)}</select></label>
   {'value' in condition&&<><label className="block space-y-1 text-sm" htmlFor={`${id}-value`}><span>{labels.value}</span><input id={`${id}-value`} className={control} type={condition.value.kind==='date'?'date':'text'} inputMode={condition.value.kind==='currency'?'decimal':undefined} maxLength={condition.value.kind==='text'?10000:30} value={condition.value.value} onChange={event=>onChange({...condition,value:{...condition.value,value:event.target.value}})}/></label>{condition.value.kind==='currency'&&<label className="block space-y-1 text-sm" htmlFor={`${id}-currency`}><span>{labels.currency}</span><select id={`${id}-currency`} className={control} value={condition.value.currency} onChange={event=>onChange({...condition,value:{...condition.value as Extract<LetterValue,{kind:'currency'}>,currency:event.target.value}})}><option value="">—</option>{CURRENCIES.map(currency=><option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label>}</>}
  </>}
 </div>;
}
