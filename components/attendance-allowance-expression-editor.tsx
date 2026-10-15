'use client';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { ALLOWANCE_OPERATORS } from '@/lib/attendance-allowance-vocabulary';
import { ALLOWANCE_METRICS_V3, allowanceExpressionUnit, type AllowanceExpression, type AllowanceExpressionCriterion, type AllowanceExpressionGroup, type AllowanceMetricV3 } from '@/lib/attendance-allowance-expression';

type Choice={id:string;label:string;archived?:boolean};
const freshCriterion=():AllowanceExpressionCriterion=>({id:crypto.randomUUID(),type:'criterion',field:'actualMinutes',operator:'gte',value:'8',unit:'hours'});
const freshGroup=():AllowanceExpressionGroup=>({id:crypto.randomUUID(),type:'group',logic:'and',children:[freshCriterion()]});
/** Only retained unavailable choices appear; bulk selection cannot add an archived reference. */
export function AllowanceChoices({label,choices,values,onChange}:{label:string;choices:Choice[];values:string[];onChange:(values:string[])=>void}) {
  const t=useTranslations('allowanceV3');
  const active=choices.filter(choice=>!choice.archived),unavailable=values.filter(id=>!active.some(choice=>choice.id===id));
  return <div className="space-y-2">
    <ChipMultiSelect key={active.map(choice=>choice.id).join(',')}
      name="allowance-choice" label={label} options={active.map(choice=>({value:choice.id,label:choice.label}))} defaultSelected={values}
      addPlaceholder={t('choose')} removeLabelFor={value=>t('removeValue',{value})} searchPlaceholder={t('search')}
      selectAllLabel={t('selectAll')} clearAllLabel={t('clearAll')} onSelectionChange={next=>onChange([...next,...unavailable])}/>
    {unavailable.length>0&&<div className="space-y-2"><p className="text-xs text-amber-700 dark:text-amber-300">{t('retainedUnavailable')}</p><div className="flex flex-wrap gap-2">{unavailable.map(id=><span key={id} className="inline-flex items-center gap-2 rounded-md border border-amber-500/40 px-2 py-1 text-xs">{choices.find(choice=>choice.id===id)?.label??id}<button type="button" aria-label={t('removeValue',{value:choices.find(choice=>choice.id===id)?.label??id})} onClick={()=>onChange(values.filter(value=>value!==id))}>×</button></span>)}</div></div>}
  </div>;
}
export function AttendanceAllowanceExpressionEditor({value,onChange,leaveTypes}:{value:AllowanceExpression;onChange:(value:AllowanceExpression)=>void;leaveTypes:Choice[]}) {
  return <ExpressionNode node={value} onChange={onChange} leaveTypes={leaveTypes} depth={0}/>;
}
function ExpressionNode({node,onChange,leaveTypes,depth}:{node:AllowanceExpression;onChange:(node:AllowanceExpression)=>void;leaveTypes:Choice[];depth:number}) {
  const t=useTranslations('allowanceV2'),v=useTranslations('allowanceV3');
  if(node.type==='criterion')return <div className="space-y-3 rounded-lg border border-border bg-card p-3">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Field label={t('field')}><select className={inputCls} value={node.field} onChange={event=>{const field=event.target.value as AllowanceMetricV3,unit=allowanceExpressionUnit(field);onChange({id:node.id,type:'criterion',field,operator:node.operator,value:'0',...(node.operator==='between'?{upper:'0'}:{}),unit,...(field==='leaveCount'||field==='leaveDays'?{leaveTypeIds:[]}:{} )});}}>{ALLOWANCE_METRICS_V3.map(field=><option key={field} value={field}>{t(`metrics.${field}`)}</option>)}</select></Field>
      <Field label={t('operator')}><select className={inputCls} value={node.operator} onChange={event=>{const {upper,...base}=node;onChange({...base,operator:event.target.value as typeof node.operator,...(event.target.value==='between'?{upper:upper??node.value}:{})});}}>{ALLOWANCE_OPERATORS.map(operator=><option key={operator} value={operator}>{t(`operators.${operator}`)}</option>)}</select></Field>
      <Field label={t('threshold')}><input className={inputCls} type="number" required min="0" step={node.unit==='occurrences'?'1':'0.01'} value={node.value} onChange={event=>onChange({...node,value:event.target.value})}/>{node.operator==='between'&&<input className={`${inputCls} mt-2`} aria-label={t('upper')} type="number" min="0" step={node.unit==='occurrences'?'1':'0.01'} required value={node.upper??''} onChange={event=>onChange({...node,upper:event.target.value})}/>}</Field>
      <Field label={t('unit')}><select className={inputCls} value={node.unit} onChange={event=>onChange({...node,unit:event.target.value as typeof node.unit})}>{(allowanceExpressionUnit(node.field)==='minutes'?['minutes','hours']:[allowanceExpressionUnit(node.field)]).map(unit=><option key={unit} value={unit}>{t(`units.${unit}`)}</option>)}</select></Field>
    </div>
    {(node.field==='leaveCount'||node.field==='leaveDays')&&<><AllowanceChoices label={v('leaveTypes')} choices={leaveTypes} values={node.leaveTypeIds??[]} onChange={leaveTypeIds=>onChange({...node,leaveTypeIds})}/><p className="text-xs text-muted-foreground">{v('allLeaveTypes')}</p></>}
  </div>;
  const replace=(index:number,child:AllowanceExpression)=>onChange({...node,children:node.children.map((previous,i)=>i===index?child:previous)});
  const move=(index:number,offset:number)=>{const children=[...node.children];[children[index],children[index+offset]]=[children[index+offset],children[index]];onChange({...node,children});};
  return <fieldset className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4">
    <legend className="px-1 text-xs font-medium text-muted-foreground">{depth===0?v('rootGroup'):v('nestedGroup')}</legend>
    <Field label={v('match')}><select className={inputCls} value={node.logic} onChange={event=>onChange({...node,logic:event.target.value as 'and'|'or'})}><option value="and">{v('all')}</option><option value="or">{v('any')}</option></select></Field>
    {!node.children.length&&<p className="text-sm text-muted-foreground">{depth===0?v('unrestricted'):v('emptyGroup')}</p>}
    {node.children.map((child,index)=><div key={child.id} className="min-w-0 space-y-2 border-l-2 border-border pl-3"><ExpressionNode node={child} onChange={next=>replace(index,next)} leaveTypes={leaveTypes} depth={depth+1}/><div className="flex flex-wrap justify-end gap-4 text-xs"><button type="button" disabled={index===0} className="disabled:opacity-40" aria-label={v('moveUpAt',{position:index+1})} onClick={()=>move(index,-1)}>{v('moveUp')}</button><button type="button" disabled={index===node.children.length-1} className="disabled:opacity-40" aria-label={v('moveDownAt',{position:index+1})} onClick={()=>move(index,1)}>{v('moveDown')}</button><button type="button" className="text-destructive" aria-label={v('removeAt',{position:index+1})} onClick={()=>onChange({...node,children:node.children.filter((_,i)=>i!==index)})}>{t('remove')}</button></div></div>)}
    <div className="flex flex-wrap gap-4 text-sm text-primary"><button type="button" disabled={node.children.length>=30||depth>=6} onClick={()=>onChange({...node,children:[...node.children,freshCriterion()]})}>{t('addAttendanceCriterion')}</button><button type="button" disabled={node.children.length>=30||depth>=5} onClick={()=>onChange({...node,children:[...node.children,freshGroup()]})}>{v('addGroup')}</button></div>
  </fieldset>;
}
