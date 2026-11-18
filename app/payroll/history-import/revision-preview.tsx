'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import type {ImportedTaxLine,ImportedTaxSetting} from '@/lib/payroll-import-tax-input';
import type {PcbNonCashSnapshot} from '@/localization/noncash-benefits';
import type {TaxBasisValue} from '@/lib/payroll-tax-basis';
import {formatMoney} from '@/lib/money';
import {historyRecordKey,type HistoryRevisionPlan,type HistoryRevisionRow,type ImportedPayrollValues} from '@/lib/payroll-history-revisions';

const cell='px-3 py-3 text-left align-top';
function entries(values:ImportedPayrollValues|null):Record<string,unknown>{
 if(!values)return {};
 const {statutory,...amounts}=values;
 return {...amounts,...Object.fromEntries(Object.entries(statutory).filter(([key])=>!['importedTaxBasis','bases','exemptionUsed','pcbNonCash'].includes(key)).map(([key,value])=>['statutory.'+key,value]))};
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
type ImportedWageProjection={version:1;state:'ready'|'held';year:number;settings:ImportedTaxSetting[];lines:ImportedTaxLine[];missing:string[];basis?:TaxBasisValue};
function wageProjection(row:HistoryRevisionRow):ImportedWageProjection|null{
 const raw=row.values?.statutory.importedTaxBasis;
 if(!raw||typeof raw!=='object')return null;
 const value=raw as Partial<ImportedWageProjection>;
 return value.version===1&&(value.state==='ready'||value.state==='held')&&Array.isArray(value.lines)&&Array.isArray(value.settings)&&Array.isArray(value.missing)?value as ImportedWageProjection:null;
}
function ImportedWageBasis({row}:{row:HistoryRevisionRow}){
 const t=useTranslations('payrollTaxBasis'),basis=wageProjection(row);if(!basis)return null;
 const nc=basis.basis?.pcbNonCash,noncash=nc&&typeof nc==='object'&&(nc as {version?:unknown}).version===1?nc as PcbNonCashSnapshot:null;
 const money=(amount:unknown)=>(typeof amount==='number'&&Number.isFinite(amount)||typeof amount==='string'&&/^-?\d+(\.\d+)?$/.test(amount))?formatMoney(amount as number|string,row.currency):t('unavailable');
 return <details className="mt-3"><summary className="cursor-pointer font-medium text-primary">{t('importWageBasis')}</summary><section className="mt-3 space-y-3 rounded-lg border border-border p-3" aria-label={t('importWageBasis')}>
  <p className="font-medium">{t(basis.state==='ready'?'importBasisReady':'importBasisHeld')}</p><p className="text-xs text-muted-foreground">{t('importBasisHelp')}</p><p className="text-xs text-muted-foreground">{t('pcbComparisonUnavailable')}</p>
  <dl className="space-y-2 text-sm"><div><dt className="text-muted-foreground">{t('originalImportedPcb')}</dt><dd className="tabular-nums">{money(row.values?.statutory.pcb)}</dd></div><div><dt className="text-muted-foreground">{t('cashPcbWages')}</dt><dd className="tabular-nums">{basis.state==='ready'?money(basis.basis?.pcb):t('unavailable')}</dd></div><div><dt className="text-muted-foreground">{t('noncashPcbWages')}</dt><dd className="tabular-nums">{basis.state==='ready'&&noncash?<><span>BIK: {money(noncash.current?.bik?.taxable)}</span>{' · '}<span>VOLA: {money(noncash.current?.vola?.taxable)}</span></>:basis.state==='ready'&&basis.lines.every(line=>line.direction!=='noncash')?t('noNoncashItems'):t('unavailable')}</dd></div></dl>
  {!!basis.missing.length&&<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/20"><p className="font-medium">{t('missingEvidenceTitle')}</p><ul className="mt-2 space-y-2">{basis.missing.map((missing,index)=><li key={index}>{missing}</li>)}</ul><p className="mt-2">{t('missingEvidenceHelp')}</p></div>}
  <div className="overflow-x-auto"><table className="w-full text-xs"><caption className="p-2 text-left font-medium">{t('availableItems')}</caption><thead><tr><th className="p-2 text-left">{t('payItems')}</th><th className="p-2 text-right">{t('originalAmount')}</th><th className="p-2 text-left">{t('pcbTreatment')}</th></tr></thead><tbody>{basis.lines.map((line,index)=>{const setting=basis.settings.find(setting=>setting.id===line.settingId);return <tr className="border-t border-border" key={line.rowNum+'-'+index}><th className="p-2 text-left font-medium">{line.originalCode}{line.originalCode!==line.code?' → '+line.code:''}{setting?' · '+setting.name:''}<span className="mt-1 block font-normal text-muted-foreground">{t('directions.'+line.direction)}</span></th><td className="p-2 text-right tabular-nums whitespace-nowrap">{money(line.amount)}</td><td className="p-2 text-left">{setting?t(setting.includedInPcb?'includedBeforeExemption':'notIncludedInPcb'):t('notRecorded')}</td></tr>;})}</tbody></table></div>
 </section></details>;
}
/** d28501b8 r2 — when `selection` is given, replacement rows carry a tick box; only ticked rows are overwritten. */
export type RevisionSelection={ticked:Set<string>;toggle:(key:string)=>void;toggleAll:(on:boolean)=>void};
export function RevisionPreview({plan,selection}:{plan:HistoryRevisionPlan;selection?:RevisionSelection}){
 const t=useTranslations('payroll.historyRevisions'),[page,setPage]=useState(0);
 const pages=Math.max(1,Math.ceil(plan.rows.length/50));
 const replaceRows=plan.rows.filter(row=>row.operation==='replace');
 const companies=[...new Set(plan.rows.map(row=>row.companyId||row.companyName))];
 return <div className="space-y-5">
  <div className="flex flex-wrap gap-6 rounded-lg border p-4">{(['created','replaced','unchanged','invalid'] as const).map(key=><p key={key} className="text-sm text-muted-foreground">{t(key)} <strong className="ml-2 text-lg tabular-nums text-foreground">{plan.counts[key]}</strong></p>)}</div>
  {plan.issues.length>0&&<ul role="alert" className="space-y-1 rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{plan.issues.map((issue,index)=><li key={index}>{t('sourceRow',{row:issue.rowNum})}: {issue.reason}</li>)}</ul>}
  {companies.length>0&&<div className="overflow-x-auto"><table className="w-full text-sm"><caption className="mb-2 text-left font-medium">{t('companies')}</caption><thead><tr><th className={cell}>{t('company')}</th>{(['created','replaced','unchanged','invalid'] as const).map(key=><th key={key} className={cell}>{t(key)}</th>)}</tr></thead><tbody>{companies.map(id=>{const rows=plan.rows.filter(row=>(row.companyId||row.companyName)===id);return <tr key={id} className="border-t"><th className={cell}>{rows[0].companyName||t('unresolved')}</th>{(['create','replace','unchanged','invalid'] as const).map(key=><td key={key} className={cell+' tabular-nums'}>{rows.filter(row=>row.operation===key).length}</td>)}</tr>;})}</tbody></table></div>}
  {pages>1&&<nav aria-label={t('pagination')} className="flex items-center justify-end gap-3 text-sm"><button type="button" className="rounded border px-3 py-2 disabled:opacity-40" disabled={page===0} onClick={()=>setPage(value=>value-1)}>{t('previous')}</button><span>{t('page',{current:page+1,total:pages})}</span><button type="button" className="rounded border px-3 py-2 disabled:opacity-40" disabled={page+1===pages} onClick={()=>setPage(value=>value+1)}>{t('next')}</button></nav>}
  <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm"><caption className="p-3 text-left font-medium">{t('records')}</caption><thead className="bg-muted/50"><tr>{selection&&<th className={cell+' w-10'}><input type="checkbox" aria-label={t('selectAll')} checked={replaceRows.length>0&&replaceRows.every(row=>selection.ticked.has(historyRecordKey(row)))} onChange={event=>selection.toggleAll(event.target.checked)}/></th>}{['company','employee','period','cycle','items','outcome','details'].map(key=><th key={key} className={cell}>{t(key)}</th>)}</tr></thead><tbody>{plan.rows.slice(page*50,(page+1)*50).map((row,index)=><tr key={index} className="border-t">{selection&&<td className={cell}>{row.operation==='replace'&&<input type="checkbox" aria-label={t('tickRow',{employee:row.employeeNo,period:row.period})} checked={selection.ticked.has(historyRecordKey(row))} onChange={()=>selection.toggle(historyRecordKey(row))}/>}</td>}<td className={cell}>{row.companyName||'—'}</td><td className={cell}>{row.employeeNo||'—'}{row.employeeName&&<span> · {row.employeeName}</span>}<p className="mt-1 text-xs text-muted-foreground">{t('sourceRows',{rows:row.rowNums.join(', ')})}</p></td><td className={cell}>{row.period||'—'}</td><td className={cell}>{row.cycleName?`${row.cycleName} - By Import`:'—'}</td><td className={cell+' max-w-56 font-mono text-xs'}>{row.codes?.length?row.codes.join(', '):'—'}</td><td className={cell}>{row.protected?<span className="font-medium text-muted-foreground">{t('operations.protected')}</span>:<span className={row.operation==='invalid'?'text-destructive':'font-medium'}>{t(`operations.${row.operation}`)}</span>}</td><td className={cell+' min-w-64'}>{row.protected&&<p className="mb-1 font-medium">{t('protectedHint')}</p>}{row.operation==='replace'&&row.overwriteSource&&<p className="mb-1 font-medium">{t(row.overwriteSource==='processed'?'sourceProcessed':'sourceImported')}</p>}{row.operation!=='invalid'&&row.warnings?.map((warning,i)=><p key={'w'+i} className="mb-1 text-amber-700 dark:text-amber-400">{warning}</p>)}{row.reasons.map((reason,i)=><p key={i} className="mb-1 text-destructive">{reason}</p>)}{(row.values||row.beforeValues)&&<details><summary className="cursor-pointer font-medium text-primary">{t('compare')}</summary><Amounts row={row}/></details>}<ImportedWageBasis row={row}/></td></tr>)}</tbody></table></div>
 </div>;
}
