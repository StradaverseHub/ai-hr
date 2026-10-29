'use client';

import {useTranslations} from 'next-intl';
import {OvertimeSelectionValues} from './selection-values';
import {OvertimePositionValues} from './position-values';
import {useOvertimeChoiceText} from './choice-label';
import {Field, inputCls} from '@/components/ui';
import {
  OVERTIME_NUMERIC_FIELDS, OVERTIME_SELECTION_FIELDS, OVERTIME_LIMITS, OVERTIME_ASSIGNMENT_SELECTION_FIELDS, OVERTIME_ASSIGNMENT_CONDITION_TYPES,
  type OvertimeCondition, type OvertimeExpression, type OvertimeNumericField,
  type OvertimeSelectionField, type OvertimeUnit,
} from '@/lib/overtime-pattern-model';

export type OvertimeChoice = {id:string;label:string};
export type OvertimeChoices = Partial<Record<OvertimeSelectionField,OvertimeChoice[]>>;
export const ruleId = () => crypto.randomUUID();
export const blankLiteral = (unit:OvertimeUnit, currency:string):OvertimeExpression => ({
  id:ruleId(), type:'literal', unit, value:'', ...(['money','moneyPerHour'].includes(unit) ? {currency} : {}),
});
export const blankCondition = ():OvertimeCondition => ({id:ruleId(),type:'group',logic:'and',children:[]});
const button = 'min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
const units = ['scalar','minutes','money','moneyPerHour'] as const;
const operations = ['literal','field','ref','if','add','subtract','multiply','divide','min','max','cap','hourlyRate','hourlyAmount'] as const;

/** Pure editing only: server validation and evaluation retain dimension, bound and money authority. */
export function ExpressionControl({value,onChange,currency,choices={},definitions=[],depth=0,label}:{
  value:OvertimeExpression;onChange:(next:OvertimeExpression)=>void;currency:string;
  choices?:OvertimeChoices;definitions?:string[];depth?:number;label:string;
}) {
  const t=useTranslations('overtimePatterns');
  if(depth>=OVERTIME_LIMITS.depth) return <p role="alert">{t('errors.limit')}</p>;
  function changeType(type:typeof operations[number]) {
    const common={id:value.id,unit:value.unit};
    const literal=(unit=value.unit)=>blankLiteral(unit,currency);
    let next:OvertimeExpression;
    switch(type) {
      case 'literal': next={...literal(),id:value.id};break;
      case 'field': next={...common,type,field:'rawMinutes',unit:'minutes'};break;
      case 'ref': next={...common,type,definitionId:''};break;
      case 'if': next={...common,type,when:blankCondition(),then:literal(),else:literal()};break;
      case 'cap': next={...common,type,value:literal(),ceiling:literal()};break;
      case 'hourlyRate': next={...common,type,unit:'moneyPerHour',base:literal('money'),divisorMinutes:literal('minutes')};break;
      case 'hourlyAmount': next={...common,type,unit:'money',rate:literal('moneyPerHour'),minutes:literal('minutes')};break;
      default: next={...common,type,left:literal(),right:literal(type==='multiply'||type==='divide'?'scalar':value.unit)};
    }
    onChange(next);
  }
  const child=(expression:OvertimeExpression,replace:(next:OvertimeExpression)=>void,key:string)=><ExpressionControl value={expression} onChange={replace} currency={currency} choices={choices} definitions={definitions} depth={depth+1} label={t(key)}/>;
  return <fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-3">
    <legend className="px-1 text-xs font-medium text-muted-foreground">{label}</legend>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('operation')}><select className={inputCls} value={value.type} onChange={event=>changeType(event.target.value as typeof operations[number])}>{operations.map(type=><option key={type} value={type}>{t(`operations.${type}`)}</option>)}</select></Field>
      <Field label={t('unit')}><select className={inputCls} value={value.unit} onChange={event=>onChange({...value,unit:event.target.value as OvertimeUnit,...(value.type==='literal'&&['money','moneyPerHour'].includes(event.target.value)?{currency}:{})})}>{units.map(unit=><option key={unit} value={unit}>{t(`units.${unit}`)}</option>)}</select></Field>
    </div>
    {value.type==='literal'?<Field label={t('decimalValue')}><input className={inputCls} inputMode="decimal" value={value.value} onChange={event=>onChange({...value,value:event.target.value,...(['money','moneyPerHour'].includes(value.unit)?{currency}:{})})}/></Field>:null}
    {value.type==='field'?<Field label={t('field')}><select className={inputCls} value={value.field} onChange={event=>{const field=event.target.value as OvertimeNumericField;onChange({...value,field,unit:OVERTIME_NUMERIC_FIELDS[field]});}}>{Object.keys(OVERTIME_NUMERIC_FIELDS).map(field=><option key={field} value={field}>{t(`fields.${field}`)}</option>)}</select></Field>:null}
    {value.type==='ref'?<Field label={t('definition')}><select className={inputCls} value={value.definitionId} onChange={event=>onChange({...value,definitionId:event.target.value})}><option value="">{t('choose')}</option>{definitions.map((id,index)=><option key={id} value={id}>{t('numberedDefinition',{number:index+1})}</option>)}</select></Field>:null}
    {value.type==='if'?<>
      <ConditionControl value={value.when} onChange={when=>onChange({...value,when})} currency={currency} choices={choices} definitions={definitions} depth={depth+1}/>
      {child(value.then,then=>onChange({...value,then}),'then')}
      {child(value.else,other=>onChange({...value,else:other}),'else')}
    </>:null}
    {'left' in value?<div className="grid gap-3 lg:grid-cols-2">{child(value.left,left=>onChange({...value,left}),'left')}{child(value.right,right=>onChange({...value,right}),'right')}</div>:null}
    {value.type==='cap'?<>{child(value.value,next=>onChange({...value,value:next}),'capInput')}{child(value.ceiling,ceiling=>onChange({...value,ceiling}),'ceiling')}</>:null}
    {value.type==='hourlyRate'?<>{child(value.base,base=>onChange({...value,base}),'base')}{child(value.divisorMinutes,divisorMinutes=>onChange({...value,divisorMinutes}),'divisorMinutes')}</>:null}
    {value.type==='hourlyAmount'?<>{child(value.rate,rate=>onChange({...value,rate}),'hourlyRate')}{child(value.minutes,minutes=>onChange({...value,minutes}),'minutes')}</>:null}
  </fieldset>;
}

export function ConditionControl({value,onChange,currency,choices={},definitions=[],depth=0,assignment=false}:{
  value:OvertimeCondition;onChange:(next:OvertimeCondition)=>void;currency:string;
  choices?:OvertimeChoices;definitions?:string[];depth?:number;assignment?:boolean;
}) {
  const t=useTranslations('overtimePatterns');
  const choiceText=useOvertimeChoiceText();
  if(depth>=OVERTIME_LIMITS.depth) return <p role="alert">{t('errors.limit')}</p>;
  const types=assignment?OVERTIME_ASSIGNMENT_CONDITION_TYPES:['constant','group','selection','null','compare','clock'] as const;
  function changeType(type:typeof types[number]) {
    const id=value.id;
    switch(type) {
      case 'constant':onChange({id,type,value:false});break;
      case 'group':onChange({id,type,logic:'and',children:[]});break;
      case 'selection':onChange({id,type,field:'companyId',operator:'in',values:[]});break;
      case 'null':onChange({id,type,field:'companyId',isNull:true});break;
      case 'clock':onChange({id,type,boundary:'start',operator:'after',value:{dayOffset:0,minute:0}});break;
      case 'compare':onChange({id,type,operator:'gte',left:{id:ruleId(),type:'field',unit:'minutes',field:'rawMinutes'},right:blankLiteral('minutes',currency)});break;
    }
  }
  return <fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-3">
    <legend className="px-1 text-xs font-medium text-muted-foreground">{t('condition')}</legend>
    <Field label={t('conditionType')}><select className={inputCls} value={value.type} onChange={event=>changeType(event.target.value as typeof types[number])}>{types.map(type=><option key={type} value={type}>{t(`conditionTypes.${type}`)}</option>)}</select></Field>
    {value.type==='constant'?<Field label={t('match')}><select className={inputCls} value={String(value.value)} onChange={event=>onChange({...value,value:event.target.value==='true'})}><option value="false">{t('never')}</option><option value="true">{t('always')}</option></select></Field>:null}
    {value.type==='group'?<>
      <Field label={t('match')}><select className={inputCls} value={value.logic} onChange={event=>onChange({...value,logic:event.target.value as 'and'|'or'})}><option value="and">{t('all')}</option><option value="or">{t('any')}</option></select></Field>
      {value.children.map((condition,index)=><div key={condition.id} className="space-y-2 border-l-2 border-border pl-3">
        <ConditionControl value={condition} onChange={next=>onChange({...value,children:value.children.map((old,i)=>i===index?next:old)})} currency={currency} choices={choices} definitions={definitions} depth={depth+1} assignment={assignment}/>
        <button type="button" className={button} onClick={()=>onChange({...value,children:value.children.filter((_,i)=>i!==index)})}>{t('remove')}</button>
      </div>)}
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={value.children.length>=OVERTIME_LIMITS.nodes} onClick={()=>onChange({...value,children:[...value.children,{id:ruleId(),type:'selection',field:'companyId',operator:'in',values:[]}]})}>{t('addCondition')}</button><button type="button" className={button} onClick={()=>onChange({...value,children:[...value.children,blankCondition()]})}>{t('addGroup')}</button></div>
    </>:null}
    {value.type==='selection'||value.type==='null'?<Field label={t('field')}><select className={inputCls} value={value.field} onChange={event=>{const field=event.target.value as OvertimeSelectionField;onChange(value.type==='selection'?{...value,field,values:[]}:{...value,field});}}>{(assignment?OVERTIME_ASSIGNMENT_SELECTION_FIELDS:OVERTIME_SELECTION_FIELDS).map(field=><option key={field} value={field}>{t(`fields.${field}`)}</option>)}</select></Field>:null}
    {value.type==='selection'?<>
      <Field label={t('operator')}><select className={inputCls} value={value.operator} onChange={event=>onChange({...value,operator:event.target.value as 'in'|'notIn'})}><option value="in">{t('operators.in')}</option><option value="notIn">{t('operators.notIn')}</option></select></Field>
      {value.field==='positionId'?<OvertimePositionValues options={choices.positionId??[]} selected={value.values} onChange={values=>onChange({...value,values})}/>:<OvertimeSelectionValues field={value.field} options={choices[value.field]??[]} selected={value.values} onChange={values=>onChange({...value,values})}/>}
      {!(choices[value.field]?.length)?<p className="text-xs text-muted-foreground">{t('noChoices')}</p>:null}
    </>:null}
    {value.type==='null'?<Field label={t('operator')}><select className={inputCls} value={String(value.isNull)} onChange={event=>onChange({...value,isNull:event.target.value==='true'})}><option value="true">{t('isMissing')}</option><option value="false">{t('isPresent')}</option></select></Field>:null}
    {value.type==='clock'?<>
      <div className="grid gap-3 sm:grid-cols-2"><Field label={t('clockBoundary')}><select className={inputCls} value={value.boundary} onChange={event=>onChange({...value,boundary:event.target.value as 'start'|'end'})}><option value="start">{t('recordedWorkStart')}</option><option value="end">{t('recordedWorkEnd')}</option></select></Field><Field label={t('operator')}><select className={inputCls} value={value.operator} onChange={event=>{const operator=event.target.value as typeof value.operator;onChange({...value,operator,...(operator==='between'?{upper:value.upper??{...value.value}}:{upper:undefined})});}}>{['before','after','between'].map(operator=><option key={operator} value={operator}>{t(`clockOperators.${operator}`)}</option>)}</select></Field></div>
      <div className="grid gap-3 sm:grid-cols-2">{(['value',...(value.operator==='between'?['upper']:[])] as ('value'|'upper')[]).map(key=>{const clock=value[key];if(!clock)return null;return <fieldset key={key} className="space-y-3 rounded-lg border border-border p-3"><legend className="px-1 text-sm">{t(key==='value'?'clockValue':'upper')}</legend><Field label={t('clockDay')}><select className={inputCls} value={clock.dayOffset} onChange={event=>onChange({...value,[key]:{...clock,dayOffset:Number(event.target.value) as 0|1|2}})}>{[0,1,2].map(offset=><option key={offset} value={offset}>{t(`clockDays.day${offset}`)}</option>)}</select></Field><Field label={t('clockValue')}><input type="time" className={inputCls} value={`${String(Math.floor(clock.minute/60)).padStart(2,'0')}:${String(clock.minute%60).padStart(2,'0')}`} onChange={event=>{const [hours,minutes]=event.target.value.split(':').map(Number);onChange({...value,[key]:{...clock,minute:hours*60+minutes}});}}/></Field></fieldset>;})}</div>
      <p className="text-xs text-muted-foreground">{t('clockConditionHelp')}</p>
    </>:null}
    {value.type==='compare'?<>
      <Field label={t('operator')}><select className={inputCls} value={value.operator} onChange={event=>{const operator=event.target.value as typeof value.operator;onChange({...value,operator,...(operator==='between'?{upper:value.upper??blankLiteral(value.left.unit,currency)}:{upper:undefined})});}}>{['eq','ne','lt','lte','gt','gte','between'].map(operator=><option key={operator} value={operator}>{t(`operators.${operator}`)}</option>)}</select></Field>
      <ExpressionControl label={t('left')} value={value.left} onChange={left=>onChange({...value,left})} currency={currency} choices={choices} definitions={definitions} depth={depth+1}/>
      <ExpressionControl label={t('right')} value={value.right} onChange={right=>onChange({...value,right})} currency={currency} choices={choices} definitions={definitions} depth={depth+1}/>
      {value.operator==='between'&&value.upper?<ExpressionControl label={t('upper')} value={value.upper} onChange={upper=>onChange({...value,upper})} currency={currency} choices={choices} definitions={definitions} depth={depth+1}/>:null}
    </>:null}
  </fieldset>;
}
