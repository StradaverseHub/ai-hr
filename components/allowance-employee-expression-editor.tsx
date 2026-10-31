'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button, Field, inputCls } from '@/components/ui';
import { searchAllowanceEmployeeValues } from '@/app/(app)/admin/attendance-allowance/actions';
import { ALLOWANCE_EMPLOYEE_FIELDS_V4, type AllowanceEmployeeExpression, type AllowanceEmployeeGroup, type AllowanceEmployeeLeaf } from '@/lib/allowance-employee-expression';
const criterion=():AllowanceEmployeeLeaf=>({id:crypto.randomUUID(),type:'criterion',field:'departmentId',operator:'in',values:[]});
export const newAllowanceEmployeeGroup=():AllowanceEmployeeGroup=>({id:crypto.randomUUID(),type:'group',logic:'and',children:[criterion()]});
type ReportLabels=(field:string,rows:{id:string;label:string}[])=>void;
export function AllowanceEmployeeExpressionEditor({value,companyId,onChange,onLabels}:{value:AllowanceEmployeeGroup;companyId:string;onChange:(value:AllowanceEmployeeGroup)=>void;onLabels?:ReportLabels}) {
  return <EmployeeNode node={value} companyId={companyId} onLabels={onLabels} depth={0} onChange={next=>{if(next.type==='group')onChange(next);}}/>;
}
function EmployeeNode({node,companyId,depth,onChange,onLabels}:{node:AllowanceEmployeeExpression;companyId:string;depth:number;onChange:(value:AllowanceEmployeeExpression)=>void;onLabels?:ReportLabels}) {
  const t=useTranslations('allowanceV4'),v=useTranslations('allowanceV3'),old=useTranslations('allowanceV2');
  if(node.type==='criterion')return <div className="min-w-0 space-y-3 rounded-lg border border-border p-3">
    <div className="grid gap-3 sm:grid-cols-2"><Field label={old('field')}><select className={inputCls} value={node.field} onChange={event=>onChange({...node,field:event.target.value as typeof node.field,values:[]})}>{ALLOWANCE_EMPLOYEE_FIELDS_V4.map(field=><option key={field} value={field}>{field==='branch'||field==='division'?t(field):old(`employeeFields.${field}`)}</option>)}</select></Field>
    <Field label={old('operator')}><select className={inputCls} value={node.operator} onChange={event=>{const operator=event.target.value as typeof node.operator;onChange({...node,operator,values:operator==='is'||operator==='isNot'?node.values.slice(0,1):node.values});}}>{['is','isNot','in','notIn'].map(operator=><option key={operator} value={operator}>{t(`operators.${operator}`)}</option>)}</select></Field></div>
    <EmployeeValues key={`${companyId}:${node.field}`} companyId={companyId} node={node} onLabels={onLabels} onChange={values=>onChange({...node,values})}/>
  </div>;
  const replace=(index:number,value:AllowanceEmployeeExpression)=>onChange({...node,children:node.children.map((child,i)=>i===index?value:child)});
  const move=(index:number,offset:number)=>{const children=[...node.children];[children[index],children[index+offset]]=[children[index+offset],children[index]];onChange({...node,children});};
  return <fieldset className="min-w-0 space-y-3 rounded-xl border border-border p-3 sm:p-4"><legend className="px-1 text-sm font-medium">{depth===0?t('employeeGroup'):v('nestedGroup')}</legend>
    <Field label={old('employeeLogic')}><select className={inputCls} value={node.logic} onChange={event=>onChange({...node,logic:event.target.value as 'and'|'or'})}><option value="and">{old('and')}</option><option value="or">{old('or')}</option></select></Field>
    {!node.children.length&&<p className="text-sm text-muted-foreground">{t('emptyGroup')}</p>}
    {node.children.map((child,index)=><div key={child.id} className="min-w-0 space-y-2"><EmployeeNode node={child} companyId={companyId} onLabels={onLabels} depth={depth+1} onChange={value=>replace(index,value)}/><div className="flex flex-wrap justify-end gap-2"><Button type="button" size="sm" variant="ghost" disabled={index===0} aria-label={v('moveUpAt',{position:index+1})} onClick={()=>move(index,-1)}>{v('moveUp')}</Button><Button type="button" size="sm" variant="ghost" disabled={index===node.children.length-1} aria-label={v('moveDownAt',{position:index+1})} onClick={()=>move(index,1)}>{v('moveDown')}</Button><Button type="button" size="sm" variant="ghost" aria-label={v('removeAt',{position:index+1})} onClick={()=>onChange({...node,children:node.children.filter((_,i)=>i!==index)})}>{old('remove')}</Button></div></div>)}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={node.children.length>=30||depth>=6} onClick={()=>onChange({...node,children:[...node.children,criterion()]})}>{old('addEmployeeCriterion')}</Button><Button type="button" variant="secondary" disabled={node.children.length>=30||depth>=5} onClick={()=>onChange({...node,children:[...node.children,newAllowanceEmployeeGroup()]})}>{v('addGroup')}</Button></div>
  </fieldset>;
}
function EmployeeValues({companyId,node,onChange,onLabels}:{companyId:string;node:AllowanceEmployeeLeaf;onChange:(values:string[])=>void;onLabels?:ReportLabels}) {
  const t=useTranslations('allowanceV4'),old=useTranslations('allowanceV2');
  const [query,setQuery]=useState(''),[page,setPage]=useState(1),[retry,setRetry]=useState(0);
  const [rows,setRows]=useState<{id:string;label:string}[]>([]),[labels,setLabels]=useState<Record<string,string>>({}),[more,setMore]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(false);
  const selectedKey=JSON.stringify(node.values);
  useEffect(()=>{let active=true;if(!JSON.parse(selectedKey).length)return;searchAllowanceEmployeeValues({companyId,field:node.field,query:'',page:1,selected:JSON.parse(selectedKey)}).then(result=>{if(active){setLabels(previous=>({...previous,...Object.fromEntries(result.rows.map(row=>[row.id,row.label]))}));onLabels?.(node.field,result.rows);}}).catch(()=>{});return()=>{active=false;};},[companyId,node.field,selectedKey,onLabels]);
  useEffect(()=>{let active=true;setLoading(true);setError(false);const timeout=setTimeout(()=>{searchAllowanceEmployeeValues({companyId,field:node.field,query,page}).then(result=>{if(active){setRows(result.rows);setMore(result.hasMore);onLabels?.(node.field,result.rows);setLabels(previous=>({...previous,...Object.fromEntries(result.rows.map(row=>[row.id,row.label]))}));setLoading(false);}}).catch(()=>{if(active){setError(true);setLoading(false);}});},200);return()=>{active=false;clearTimeout(timeout);};},[companyId,node.field,query,page,retry,onLabels]);
  const label=(row:{id:string;label:string})=>node.field==='status'?old(`status.${row.id}`):node.field==='employmentType'?old(`employmentType.${row.id}`):row.label;
  return <div className="space-y-2" aria-busy={loading}>
    <div className="flex flex-wrap gap-2">{node.values.map(value=><span key={value} className="inline-flex max-w-full items-center gap-2 rounded-md border border-border px-2 py-1 text-sm"><span className="break-words">{label({id:value,label:labels[value]??value})}</span><button type="button" className="inline-flex min-h-8 min-w-8 items-center justify-center" aria-label={t('removeValue',{value:labels[value]??value})} onClick={()=>onChange(node.values.filter(id=>id!==value))}><X className="size-4" aria-hidden/></button></span>)}</div>
    <label className="block text-sm"><span className="sr-only">{t('searchValues')}</span><input type="search" className={inputCls} placeholder={t('searchValues')} value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}}/></label>
    {error?<div role="alert"><p className="text-sm">{t('loadError')}</p><Button type="button" variant="ghost" onClick={()=>setRetry(value=>value+1)}>{t('retry')}</Button></div>:loading?<p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>:<div className="max-h-60 overflow-auto rounded-lg border border-border p-2">{!rows.length?<p className="p-2 text-sm text-muted-foreground">{t('empty')}</p>:rows.map(row=><label key={row.id} className="flex min-h-11 cursor-pointer items-center gap-3 p-2 text-sm"><input type="checkbox" checked={node.values.includes(row.id)} onChange={()=>onChange(node.values.includes(row.id)?node.values.filter(value=>value!==row.id):node.operator==='is'||node.operator==='isNot'?[row.id]:[...node.values,row.id])}/><span>{label(row)}</span></label>)}</div>}
    <div className="flex justify-between"><Button type="button" variant="ghost" disabled={page===1||loading} onClick={()=>setPage(value=>value-1)}>{t('previous')}</Button><span className="self-center text-xs">{t('page',{page})}</span><Button type="button" variant="ghost" disabled={!more||loading} onClick={()=>setPage(value=>value+1)}>{t('next')}</Button></div>
  </div>;
}
