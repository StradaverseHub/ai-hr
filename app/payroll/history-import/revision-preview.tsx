'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {formatMoney} from '@/lib/money';
import type {HistoryRevisionPlan,HistoryRevisionRow,ImportedPayrollValues} from '@/lib/payroll-history-revisions';

const cell='px-3 py-3 text-left align-top';
function entries(values:ImportedPayrollValues|null):Record<string,unknown>{
 if(!values)return {};
 const {statutory,...amounts}=values;
 return {...amounts,...Object.fromEntries(Object.entries(statutory).map(([key,value])=>['statutory.'+key,value]))};
}
function Amounts({row}:{row:HistoryRevisionRow}){
 const t=useTranslations('payroll.historyRevisions');
 const before=entries(row.beforeValues),after=entries(row.values),keys=[...new Set([...Object.keys(before),...Object.keys(after)])];
 function value(raw:unknown,key:string){
  if(raw==null)return '—';
  if(key.endsWith('.version'))return String(raw);
  if((typeof raw==='number'||typeof raw==='string')&&/^-?\d+(\.\d+)?$/.test(String(raw)))return formatMoney(raw,row.currency);
  return typeof raw==='object'?JSON.stringify(raw):String(raw);
 }
 return <table className="w-full text-sm"><thead><tr><th className={cell}>{t('amount')}</th><th className={cell}>{t('before')}</th><th className={cell}>{t('after')}</th></tr></thead><tbody>{keys.map(key=><tr key={key} className={JSON.stringify(before[key])!==JSON.stringify(after[key])?'bg-primary/5':''}><th className={cell}>{t.has('amountLabels.'+key)?t(`amountLabels.${key}`):key}</th><td className={cell+' tabular-nums'}>{value(before[key],key)}</td><td className={cell+' tabular-nums'}>{value(after[key],key)}</td></tr>)}</tbody></table>;
}
export function RevisionPreview({plan}:{plan:HistoryRevisionPlan}){
 const t=useTranslations('payroll.historyRevisions'),[page,setPage]=useState(0);
 const pages=Math.max(1,Math.ceil(plan.rows.length/50));
 const companies=[...new Set(plan.rows.map(row=>row.companyId||row.companyName))];
 return <div className="space-y-5">
  <div className="flex flex-wrap gap-6 rounded-lg border p-4">{(['created','replaced','unchanged','invalid'] as const).map(key=><p key={key} className="text-sm text-muted-foreground">{t(key)} <strong className="ml-2 text-lg tabular-nums text-foreground">{plan.counts[key]}</strong></p>)}</div>
  {plan.issues.length>0&&<ul role="alert" className="space-y-1 rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{plan.issues.map((issue,index)=><li key={index}>{t('sourceRow',{row:issue.rowNum})}: {issue.reason}</li>)}</ul>}
  {companies.length>0&&<div className="overflow-x-auto"><table className="w-full text-sm"><caption className="mb-2 text-left font-medium">{t('companies')}</caption><thead><tr><th className={cell}>{t('company')}</th>{(['created','replaced','unchanged','invalid'] as const).map(key=><th key={key} className={cell}>{t(key)}</th>)}</tr></thead><tbody>{companies.map(id=>{const rows=plan.rows.filter(row=>(row.companyId||row.companyName)===id);return <tr key={id} className="border-t"><th className={cell}>{rows[0].companyName||t('unresolved')}</th>{(['create','replace','unchanged','invalid'] as const).map(key=><td key={key} className={cell+' tabular-nums'}>{rows.filter(row=>row.operation===key).length}</td>)}</tr>;})}</tbody></table></div>}
  <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm"><caption className="p-3 text-left font-medium">{t('records')}</caption><thead className="bg-muted/50"><tr>{['company','employee','period','cycle','outcome','details'].map(key=><th key={key} className={cell}>{t(key)}</th>)}</tr></thead><tbody>{plan.rows.slice(page*50,(page+1)*50).map((row,index)=><tr key={index} className="border-t"><td className={cell}>{row.companyName||'—'}</td><td className={cell}>{row.employeeNo||'—'}<p className="mt-1 text-xs text-muted-foreground">{t('sourceRows',{rows:row.rowNums.join(', ')})}</p></td><td className={cell}>{row.period||'—'}</td><td className={cell}>{row.cycleName?`${row.cycleName} - By Import`:'—'}</td><td className={cell}><span className={row.operation==='invalid'?'text-destructive':'font-medium'}>{t(`operations.${row.operation}`)}</span></td><td className={cell+' min-w-64'}>{row.reasons.map((reason,i)=><p key={i} className="mb-1 text-destructive">{reason}</p>)}{(row.values||row.beforeValues)&&<details><summary className="cursor-pointer font-medium text-primary">{t('compare')}</summary><Amounts row={row}/></details>}</td></tr>)}</tbody></table></div>
  {pages>1&&<nav aria-label={t('pagination')} className="flex items-center justify-end gap-3 text-sm"><button type="button" className="rounded border px-3 py-2 disabled:opacity-40" disabled={page===0} onClick={()=>setPage(value=>value-1)}>{t('previous')}</button><span>{t('page',{current:page+1,total:pages})}</span><button type="button" className="rounded border px-3 py-2 disabled:opacity-40" disabled={page+1===pages} onClick={()=>setPage(value=>value+1)}>{t('next')}</button></nav>}
 </div>;
}
