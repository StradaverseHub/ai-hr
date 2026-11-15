'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {conditionFieldsForTrigger,type AutomationModuleCatalogue} from '@/lib/automation/catalogue';
import type {AutomationCondition,AutomationConditionOp} from '@/lib/automation/conditions';
import {MultiSelect} from '../multi-select';

const OP_KEYS: Record<AutomationConditionOp, string> = { is: 'ops.is', isNot: 'ops.isNot', lt: 'ops.lt', lte: 'ops.lte', gte: 'ops.gte' };
const DEFAULT_OPS: readonly AutomationConditionOp[] = ['is', 'isNot'];
const numeric = (op: AutomationConditionOp) => op === 'lt' || op === 'lte' || op === 'gte';

/**
 * "Only if" rows (workflow and step level). Only the fields the trigger can supply are offered; a condition whose field
 * the trigger cannot supply stays visible (and is reported as a problem) until it is changed or removed.
 * `is` / `is not` take several values: is matches any, is not matches none.
 */
export function ConditionRows({catalogue,trigger,conditions,onChange,valuesFor,addLabel,hint,disabled=false,label}:{catalogue:AutomationModuleCatalogue;trigger:string;conditions:readonly AutomationCondition[];onChange:(next:AutomationCondition[])=>void;valuesFor:(field:string)=>readonly {value:string;label:string}[];addLabel:string;hint?:string;disabled?:boolean;label:string}){
 const t=useTranslations('automation');
 const fields=conditionFieldsForTrigger(catalogue,trigger);
 // Catalogue values are their own labels; runtime choices (organisation ids, grades) carry a label.
 const choices=(field:string)=>{const spec=catalogue.conditionFields.find(f=>f.id===field);return spec?.values?spec.values.map(value=>({value,label:value})):[...valuesFor(field)];};
 const fresh=(field:string,op?:AutomationConditionOp):AutomationCondition=>{const spec=catalogue.conditionFields.find(f=>f.id===field),useOp=op??spec?.ops[0]??'is',first=choices(field)[0];return{field,op:useOp,values:first!==undefined?[first.value]:numeric(useOp)?['0']:[]};};
 const update=(index:number,next:AutomationCondition)=>onChange(conditions.map((c,i)=>i===index?next:c));
 return <div className="v9-stack automation-conditions" role="group" aria-label={label}>
  {conditions.map((condition,index)=>{
   const spec=catalogue.conditionFields.find(f=>f.id===condition.field),offered=fields.some(f=>f.id===condition.field)?fields:[...(spec?[spec]:[]),...fields];
   const values=choices(condition.field),fieldLabel=spec?.label??condition.field;
   return <div key={index} className="automation-condition">
    <select aria-label={t('conditions.field')} value={condition.field} disabled={disabled} onChange={e=>update(index,fresh(e.target.value))}>
     {offered.map(f=><option key={f.id} value={f.id}>{f.label}{fields.some(x=>x.id===f.id)?'':' · '+t('conditions.unavailable')}</option>)}
    </select>
    <select aria-label={t('conditions.operator')} value={condition.op} disabled={disabled} onChange={e=>{const op=e.target.value as AutomationConditionOp;update(index,numeric(op)!==numeric(condition.op)?fresh(condition.field,op):{...condition,op});}}>
     {(spec?.ops??DEFAULT_OPS).map(op=><option key={op} value={op}>{t(OP_KEYS[op])}</option>)}
    </select>
    {numeric(condition.op)
     ?<input aria-label={t('conditions.valueFor',{field:fieldLabel})} type="number" min={0} step={1} value={condition.values[0]??''} disabled={disabled} onChange={e=>update(index,{...condition,values:[e.target.value]})}/>
     :values.length
      ?<MultiSelect label={t('conditions.valueFor',{field:fieldLabel})} value={condition.values} options={values} disabled={disabled} onChange={next=>update(index,{...condition,values:next})}/>
      :<TypedValues label={t('conditions.valueFor',{field:fieldLabel})} placeholder={t('conditions.typeValues')} values={condition.values} disabled={disabled} onChange={next=>update(index,{...condition,values:next})}/>}
    <button type="button" className="v9-button" aria-label={t('conditions.remove')} disabled={disabled} onClick={()=>onChange(conditions.filter((_,i)=>i!==index))}>×</button>
   </div>;})}
  <div className="automation-row"><button type="button" className="v9-button" disabled={disabled||!fields.length} onClick={()=>onChange([...conditions,fresh(fields[0].id)])}>{addLabel}</button>{hint&&<span className="v9-muted">{hint}</span>}</div>
 </div>;
}

/** Values typed by hand, separated by commas, for fields whose choices the module lists only at run time. */
function TypedValues({label,placeholder,values,disabled,onChange}:{label:string;placeholder:string;values:readonly string[];disabled:boolean;onChange:(next:string[])=>void}){
 const [text,setText]=useState(values.join(', '));
 return <input aria-label={label} placeholder={placeholder} value={text} disabled={disabled} onChange={e=>setText(e.target.value)} onBlur={()=>onChange([...new Set(text.split(',').map(v=>v.trim()).filter(Boolean))])}/>;
}
