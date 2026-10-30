'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import Link from 'next/link';
import {toCsv} from '@/lib/csv';
import {Button,Card,Field,inputCls} from '@/components/ui';
import {movementImportFieldLabel,movementImportIssueText} from '@/lib/movement-import-issues';
import {movementEmployeeKey,type MovementImportPreview,type MovementImportResult,type MovementImportRow} from '@/lib/movement-import-contract';
function download(data:BlobPart,type:string,name:string){const url=URL.createObjectURL(new Blob([data],{type}));const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const HISTORY='/admin/personnel/import/history';
/**
 * ac6645ec — one template for every company and movement type: no company or type is chosen first. The
 * upload is recorded in Import History; confirming names only the checked attempt and the chosen employees.
 */
export function MovementImport({onCommitPendingChange}:{onCommitPendingChange?:(pending:boolean)=>void}){
 const t=useTranslations('people.import.movement'),labels=useTranslations();
 const word=(key:string,fallback:string)=>t.has(`sheet.${key}`)?t(`sheet.${key}`):fallback;
 const [file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<MovementImportPreview|null>(null),[result,setResult]=useState<MovementImportResult|null>(null);
 const [attempt,setAttempt]=useState<{attemptId:string;previewHash:string}|null>(null);
 const [selected,setSelected]=useState<string[]>([]),[acknowledge,setAcknowledge]=useState(false),[closedPayroll,setClosedPayroll]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const revision=useRef(0),pending=useRef(false),input=useRef<HTMLInputElement>(null),summary=useRef<HTMLDivElement>(null);
 const resolver=(key:string,fallback:string)=>labels.has(key)?labels(key):fallback;
 const fieldLabel=(key:string)=>movementImportFieldLabel(key,resolver);
 const eventLabel=(code:string)=>resolver('people.detail.movement.eventType.'+code,code);
 const issueText=(issue:string|readonly string[])=>movementImportIssueText(issue,resolver);
 const reset=()=>{revision.current++;setPreview(null);setResult(null);setAttempt(null);setSelected([]);setAcknowledge(false);setClosedPayroll(false);setError(null);};
 useEffect(()=>()=>{revision.current++;},[]);
 const run=async(operation:'preview'|'apply'|'download')=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError(null);const current=revision.current;
  if(operation==='apply')onCommitPendingChange?.(true);
  if(operation==='preview'){setPreview(null);setResult(null);setAttempt(null);setSelected([]);setAcknowledge(false);setClosedPayroll(false);}
  try{
   const body=new FormData();body.set('operation',operation);
   if(operation==='preview'){if(!file)return;body.set('file',file);body.set('operationKey',crypto.randomUUID());}
   if(operation==='apply'&&attempt){body.set('attemptId',attempt.attemptId);body.set('previewHash',attempt.previewHash);body.set('employees',JSON.stringify(selected));body.set('acknowledgeExcluded',String(acknowledge));body.set('acknowledgeClosedPayroll',String(closedPayroll));}
   const response=await fetch('/admin/personnel/import/movement',{method:'POST',body});
   if(current!==revision.current)return;
   if(response.ok&&response.headers.get('content-type')?.includes('spreadsheetml')){download(await response.arrayBuffer(),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','movement-import.xlsx');return;}
   const value=await response.json();
   if(!response.ok||!value.ok){setError(value.message??issueText(value.error??'change_refused'));return;}
   if(value.preview){setPreview(value.preview);setAttempt({attemptId:value.attemptId,previewHash:value.previewHash});setSelected(value.preview.employees.filter((e:MovementImportPreview['employees'][number])=>e.fingerprint&&e.rows.every(r=>r.status==='valid')).map(movementEmployeeKey));setAcknowledge(false);requestAnimationFrame(()=>summary.current?.focus());}
   if(value.result){setResult(value.result);requestAnimationFrame(()=>summary.current?.focus());}
  }catch{if(current===revision.current)setError(operation==='apply'?t('applyFailed'):operation==='download'?word('templateFailed','The template could not be downloaded.'):t('checkFailed'));}
  finally{pending.current=false;setBusy(false);if(operation==='apply')onCommitPendingChange?.(false);}
 };
 const employees=result?.employees??preview?.employees??[];
 const excludedEmployees=preview?.employees.filter(e=>!selected.includes(movementEmployeeKey(e))).length??0;
 // 646355e5 slice C — the closed months behind the chosen employees' Update and Delete rows.
 const closedPeriods=[...new Set((preview?.employees??[]).filter(e=>selected.includes(movementEmployeeKey(e))).flatMap(e=>e.rows.flatMap(r=>r.closedPayrollPeriods??[])))].sort();
 const actionLabel=(row:MovementImportRow)=>row.action&&row.action!=='create'?word('action.'+row.action,row.action)+' · ':'';
 const canCommit=!!preview&&!!attempt&&!result&&!preview.fileErrors.length&&selected.length>0&&(!excludedEmployees||acknowledge);
 const compare=(row:MovementImportRow)=>{const fields=[...new Set([...Object.keys(row.before??{}),...Object.keys(row.proposed??{})])].filter(key=>key!=='companyName'&&row.before?.[key]!==row.proposed?.[key]);return <dl className="space-y-1 text-xs">{fields.map(key=><div key={key} className="grid gap-1 sm:grid-cols-[minmax(8rem,1fr)_1fr_1fr]"><dt className="font-medium">{fieldLabel(key)}</dt><dd className="break-words">{row.before?.[key]??'—'}</dd><dd className="break-words">{row.proposed?.[key]??'—'}</dd></div>)}</dl>;};
 const sheetRows=(row:MovementImportRow)=>(row.sourceRows??[row.source?.row??row.row]).join(', ');
 // d9e33556 — name the worksheet with its original Excel rows so a correction can be found in the file.
 const sheetPlace=(row:MovementImportRow)=>(row.source?.sheet?row.source.sheet+' · ':'')+word('rows','Rows')+' '+sheetRows(row);
 const errorsCsv=()=>download(toCsv([[t('row'),word('companyId','Company ID'),t('employeeId'),t('eventType'),t('effectiveDate'),t('errors')],...employees.flatMap(e=>e.rows.filter(r=>r.errors.length).map(r=>[sheetPlace(r),r.companyCode??'',r.employeeCode,eventLabel(r.eventType),r.effectiveDate,issueText(r.errors)]))]),'text/csv;charset=utf-8','movement-import-errors.csv');
 return <section aria-label={t('title')} className="space-y-5" aria-busy={busy}>
  <Card className="space-y-4 p-5"><h2 className="font-medium">{t('title')}</h2>
   <p className="text-sm text-muted-foreground">{word('screenHint','One template for every movement type and company. Enter one row per field that changes; rows with the same company, employee, date and event type are one movement.')}</p>
   <div className="flex flex-wrap items-center gap-2"><Button type="button" disabled={busy} onClick={()=>void run('download')}>{word('downloadTemplate','Download template')}</Button><Link className="text-sm text-primary underline" href={`${HISTORY}?kind=movement`}>{word('history','Import history')}</Link></div>
   <Field label={t('file')}><input ref={input} type="file" accept=".xlsx,.csv" disabled={busy||!!result} className={inputCls} onChange={e=>{reset();setFile(e.target.files?.[0]??null);}}/></Field>
   {file&&<p className="text-xs text-muted-foreground">{file.name}</p>}
   <Button type="button" disabled={busy||!file||!!result} onClick={()=>void run('preview')}>{busy?t('working'):t('check')}</Button>
  </Card>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!!preview?.fileErrors.length&&<div role="alert" className="rounded-lg border border-destructive p-4"><p>{t('fileRefused')}</p><ul>{preview.fileErrors.map((issue,i)=><li key={i} className="text-sm">{issueText(issue)}</li>)}</ul></div>}
  {!!employees.length&&<Card className="space-y-4 p-5"><div ref={summary} tabIndex={-1} className="outline-none"><h2 className="font-medium">{result?t('resultTitle'):t('previewTitle')}</h2><p role="status" className="text-sm">{result?t('resultCounts',{imported:result.imported,failed:result.failed,excluded:result.excluded}):t('previewCounts',{valid:preview!.valid,excluded:preview!.excluded})}</p></div>
   <p className="text-sm text-muted-foreground">{word('wholeEmployee','Each employee’s movements are imported together or not at all. Other employees still go through.')}</p>
   {employees.map(employee=>{const key=movementEmployeeKey(employee);return <section key={key} className="space-y-2 rounded-lg border p-3"><h3 className="text-sm font-medium">{employee.employeeCode} · {employee.name??t('notFound')}{employee.companyName?` · ${employee.companyName}`:''}</h3>
    {!result&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy||!employee.fingerprint||employee.rows.some(r=>r.status!=='valid')} checked={selected.includes(key)} onChange={e=>{setSelected(current=>e.target.checked?[...current,key]:current.filter(c=>c!==key));setAcknowledge(false);}}/>{word('included','Include employee')}</label>}
    <ul className="space-y-2">{employee.rows.map(row=><li key={row.row} className="space-y-1 border-t pt-2"><p className="text-sm font-medium">{actionLabel(row)}{eventLabel(row.eventType)} · {row.effectiveDate} · {sheetPlace(row)} · {t(`rowStatus.${row.status}`)}</p>
     {row.errors.length>0&&<p className="text-xs text-destructive">{issueText(row.errors)}</p>}
     {!!row.closedPayrollPeriods?.length&&<p className="text-xs text-amber-700 dark:text-amber-400">{t('sheet.closedPayrollRow',{periods:row.closedPayrollPeriods.join(', ')})}</p>}
     {!!row.warnings?.length&&<p className="text-xs text-amber-700 dark:text-amber-400">{issueText(row.warnings)}</p>}
     {row.proposed&&<><div className="grid grid-cols-3 text-xs font-medium"><span>{t('field')}</span><span>{t('current')}</span><span>{t('proposed')}</span></div>{compare(row)}</>}</li>)}</ul>
    {result&&employee.employmentId&&<Link className="text-sm underline" href={'/admin/personnel/'+employee.employmentId+'?tab=careerMovement'}>{t('viewHistory')}</Link>}
   </section>;})}
   {result?<>{result.attemptId&&<Link className="block text-sm text-primary underline" href={`${HISTORY}/${result.attemptId}`}>{word('viewImport','View this import in Import History')}</Link>}<Button type="button" variant="secondary" onClick={()=>{reset();setFile(null);if(input.current)input.current.value='';}}>{t('startAgain')}</Button></>:<>
    {excludedEmployees>0&&<label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={busy} checked={acknowledge} onChange={e=>setAcknowledge(e.target.checked)}/>{t('excludeConfirmation',{count:preview!.employees.filter(e=>!selected.includes(movementEmployeeKey(e))).reduce((n,e)=>n+e.rows.length,0)})}</label>}
    {closedPeriods.length>0&&<div className="space-y-1 rounded-lg border border-amber-500/60 p-3 text-sm"><p className="font-medium">{t('sheet.closedPayrollTitle',{periods:closedPeriods.join(', ')})}</p><p className="text-muted-foreground">{t('sheet.closedPayrollBody')}</p>
     <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" name="acknowledgeClosedPayroll" disabled={busy} checked={closedPayroll} onChange={e=>setClosedPayroll(e.target.checked)}/>{t('sheet.closedPayrollAcknowledge')}</label></div>}
    <Button type="button" disabled={busy||!canCommit} onClick={()=>void run('apply')}>{busy?t('working'):t('confirm')}</Button>
   </>}
   {employees.some(e=>e.rows.some(r=>r.errors.length))&&<Button type="button" variant="secondary" disabled={busy} onClick={errorsCsv}>{t('downloadErrors')}</Button>}
  </Card>}
 </section>;
}
