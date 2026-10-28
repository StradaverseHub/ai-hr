'use client';
import Link from 'next/link';
import {useRef,useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {Button,Card,Field,tableWrapCls,theadCls,thCls} from '@/components/ui';
import {allocationHeaderRow,allocationWorkbookSheets} from '@/lib/cost-allocation-workbook';
import type {CostAllocationImportPlan} from '@/lib/cost-allocation-import';
import {ALLOCATION_SHEET} from '@/lib/employment-cost-allocation';
import {allocationWorkbookReferencesAction,confirmAllocationImportAction} from './cost-allocation-actions';
type ConfirmResult=Extract<Awaited<ReturnType<typeof confirmAllocationImportAction>>,{ok:true}>['result'];
/** c4055300 — one template for every company; Company Code resolved per row; every upload recorded in Import History. */
export function CostAllocationImport({onCommitPendingChange}:{onCommitPendingChange?:(pending:boolean)=>void}){
 const t=useTranslations('costAllocations');
 const[attempt,setAttempt]=useState<{attemptId:string;plan:CostAllocationImportPlan}|null>(null),[result,setResult]=useState<ConfirmResult|null>(null),[error,setError]=useState(''),[busy,start]=useTransition();
 const generation=useRef(0);const reset=()=>{generation.current++;setAttempt(null);setResult(null);setError('');};
 function download(bytes:BlobPart,name:string,type:string){const url=URL.createObjectURL(new Blob([bytes],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);}
 const downloadTemplate=()=>start(async()=>{
  setError('');
  try{
   const references=await allocationWorkbookReferencesAction();if(!references.ok){setError(t(`errors.${references.error}`));return;}
   const{buildXlsx}=await import('@/lib/spreadsheet');const sheets=allocationWorkbookSheets(references.references,t('instructions'));
   const bytes=await buildXlsx(allocationHeaderRow(),[],{sheetName:ALLOCATION_SHEET,textColumns:[0,1,2,3,4,5],columnWidths:sheets[0].columnWidths,wrapText:true,extraSheets:sheets.slice(1),validationLists:sheets[0].validationLists});
   download(bytes as BlobPart,'cost-center-allocations.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }catch(e){setError((e as Error).message);}
 });
 const upload=(file:File)=>{reset();const g=generation.current;start(async()=>{
  try{
   const response=await fetch('/admin/personnel/import/cost-allocation/upload?name='+encodeURIComponent(file.name),{method:'POST',body:file,headers:{'x-upload-operation':crypto.randomUUID()}});
   const body=await response.json().catch(()=>({error:null}));
   if(g!==generation.current)return;
   if(!response.ok){setError(response.status===413?t('fileTooLarge'):body.error??t('uploadFailed'));return;}
   setAttempt(body);
  }catch{if(g===generation.current)setError(t('uploadFailed'));}
 });};
 const confirm=()=>{if(!attempt)return;const{attemptId,plan}=attempt;onCommitPendingChange?.(true);start(async()=>{
  try{const r=await confirmAllocationImportAction(attemptId,plan.previewHash);if(r.ok){setResult(r.result);setAttempt(null);}else setError(r.error??t('saveFailed'));}
  catch{setError(t('saveFailed'));}finally{onCommitPendingChange?.(false);}
 });};
 const plan=attempt?.plan;
 return <Card className="space-y-4 p-5">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">{t('importTitle')}</h2><p className="max-w-3xl text-sm text-muted-foreground">{t('importHelp')}</p></div><Link href="/admin/personnel/import/history?kind=cost_allocations" className="text-sm text-primary underline">{t('historyLink')}</Link></div>
  <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={downloadTemplate}>{t('downloadTemplate')}</Button></div>
  <Field label={t('upload')}><input type="file" accept=".xlsx,.csv" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)upload(file);e.target.value='';}}/></Field>
  {plan&&<div className="space-y-3">
   {plan.issues.map((issue,i)=><p key={i} role="alert" className="text-sm text-destructive">{issue.reason}</p>)}
   {plan.groups.length>0&&<div className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['companyCode','employeeId','effectiveDate','sourceRows','result'].map(k=><th key={k} className={thCls}>{t(k)}</th>)}</tr></thead><tbody>{plan.groups.map(g=><tr key={g.key} className="border-t align-top"><td className="px-3 py-3">{g.companyCode}{g.companyName&&<span className="block text-xs text-muted-foreground">{g.companyName}</span>}</td><td className="px-3 py-3">{g.employeeCode}</td><td className="px-3 py-3">{g.effectiveDate}</td><td className="px-3 py-3">{g.rowNums.join(', ')}<ul className="text-xs text-muted-foreground">{g.displayRows?.map((row,i)=><li key={i}>{row.code} · {row.percentage}%</li>)}</ul></td><td className="px-3 py-3">{g.errors.length?<ul>{g.errors.map((e,i)=><li key={i} className="text-destructive">{e}</li>)}</ul>:t(g.operation==='clear'?'clearHelp':'ready')}</td></tr>)}</tbody></table></div>}
   <Button type="button" disabled={busy||!plan.counts.valid||plan.issues.length>0} onClick={confirm}>{t('saveImport',{count:plan.counts.valid})}</Button>
  </div>}
  {result&&<div role="status" className="space-y-2 text-sm"><p className="font-medium">{t('savedSummary',{succeeded:result.succeeded,failed:result.failed})}</p><ul className="space-y-1">{result.results.map(r=><li key={r.key}>{r.employeeCode} · {r.effectiveDate} · {r.saved?t('saved'):<span className="text-destructive">{r.errors.join('; ')}</span>}</li>)}</ul><Link href={'/admin/personnel/import/history/'+result.attemptId} className="text-primary underline">{t('viewHistoryEntry')}</Link></div>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </Card>;
}
