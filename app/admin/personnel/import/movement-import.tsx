'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import Link from 'next/link';
import {Button,Card,Field,inputCls} from '@/components/ui';
import {readImportFile,importFileMessageKey} from '@/lib/import-file';
import {MOVEMENT_FORM_IDS} from '@/lib/movement-form-contract';
import {personnelFormLabel} from '@/lib/personnel-form-contract';
import {movementImportWorkbook,movementImportCsvTemplate} from '@/lib/movement-import-template';
import {retainMovementExclusionReasons,type MovementImportPreview,type MovementImportResult,type MovementImportRow} from '@/lib/movement-import-contract';
import {toCsv} from '@/lib/csv';
import {movementCatalogAction,previewMovementAction,commitMovementAction} from './movement-actions';
const equalSelection=(a:number[],b:number[])=>[...a].sort((x,y)=>x-y).join(',')===[...b].sort((x,y)=>x-y).join(',');
function download(data:BlobPart,type:string,name:string){const url=URL.createObjectURL(new Blob([data],{type}));const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();URL.revokeObjectURL(url);}
export function MovementImport({companies,defaultCompanyId,onCommitPendingChange}:{companies:{id:string;name:string}[];defaultCompanyId:string;onCommitPendingChange?:(pending:boolean)=>void}){
 const t=useTranslations('people.import.movement'),imports=useTranslations('people.import'),labels=useTranslations();
 const [companyId,setCompanyId]=useState(defaultCompanyId),[csv,setCsv]=useState(''),[fileName,setFileName]=useState('');
 const [preview,setPreview]=useState<MovementImportPreview|null>(null),[result,setResult]=useState<MovementImportResult|null>(null);
 const [selection,setSelection]=useState<number[]>([]),[acknowledge,setAcknowledge]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const revision=useRef(0),pending=useRef(false),input=useRef<HTMLInputElement>(null);
 useEffect(()=>()=>{revision.current++;},[]);
 const reset=()=>{revision.current++;setPreview(null);setResult(null);setSelection([]);setAcknowledge(false);setError(null);};
 const resolver=(key:string,fallback:string)=>labels.has(key)?labels(key):fallback;
 const fieldLabel=(key:string)=>key in MOVEMENT_FORM_IDS?personnelFormLabel(MOVEMENT_FORM_IDS[key as keyof typeof MOVEMENT_FORM_IDS],resolver):t.has('currentFields.'+key)?t('currentFields.'+key):key;
 const issueText=(issue:string):string=>issue.split('; ').map(part=>{const [code,...detail]=part.split(':');return t.has('issues.'+code)?t('issues.'+code)+(detail.length?' · '+fieldLabel(detail.join(':')):''):part;}).join('; ');
 const eventLabel=(code:string)=>labels.has('people.detail.movement.eventType.'+code)?labels('people.detail.movement.eventType.'+code):code;
 const doPreview=async(next?:number[])=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError(null);const current=revision.current;const previous=preview;setPreview(null);setAcknowledge(false);
  try{const value=await previewMovementAction(companyId,csv,next);if(current!==revision.current)return;setPreview(previous?.inputHash===value.inputHash?{...value,employees:retainMovementExclusionReasons(value.employees,previous.employees)}:value);setResult(null);setSelection(value.employees.flatMap(employee=>employee.rows.filter(row=>row.status==='valid').map(row=>row.row)));setAcknowledge(false);}
  catch{if(current===revision.current)setError(t('checkFailed'));}finally{pending.current=false;setBusy(false);}
 };
 const loadFile=async(file:File)=>{
  if(pending.current)return;reset();const current=revision.current;setBusy(true);setFileName('');
  try {const loaded=await readImportFile(file,{allowedSheets:['Instructions','Lists']});if(current!==revision.current)return;setCsv(loaded.text);setFileName(loaded.name);}
  catch(reason){if(current===revision.current)setError(imports(importFileMessageKey(reason)));}finally{if(current===revision.current)setBusy(false);if(input.current)input.current.value='';}
 };
 const template=async()=>{
  if(pending.current||!companyId)return;pending.current=true;setBusy(true);setError(null);
  try{const catalog=await movementCatalogAction(companyId);const bytes=await movementImportWorkbook(catalog,resolver);download(new Uint8Array(bytes).buffer,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','movement-import-template.xlsx');}
  catch{setError(t('templateFailed'));}finally{pending.current=false;setBusy(false);}
 };
 const canCommit=!!preview&&!result&&!preview.fileErrors.length&&selection.length>0&&preview.valid===selection.length&&equalSelection(preview.selection,selection)&&(!preview.excluded||acknowledge);
 const apply=async()=>{
  if(pending.current||!canCommit||!preview)return;pending.current=true;setBusy(true);setError(null);onCommitPendingChange?.(true);
  try{const fingerprints=Object.fromEntries(preview.employees.filter(employee=>employee.fingerprint).map(employee=>[employee.employeeCode,employee.fingerprint!]));
   const value=await commitMovementAction({companyId,csv,selection,inputHash:preview.inputHash,fingerprints,acknowledgeExcluded:acknowledge});
   setResult({...value,employees:retainMovementExclusionReasons(value.employees,preview.employees)});
  }catch{setError(t('applyFailed'));}finally{pending.current=false;setBusy(false);onCommitPendingChange?.(false);}
 };
 const employees=result?.employees??preview?.employees??[];
 const errorDownload=()=>download(toCsv([[t('row'),t('employeeId'),t('eventType'),t('effectiveDate'),t('status'),t('errors')],...employees.flatMap(employee=>employee.rows.filter(row=>row.status!=='imported'&&row.status!=='valid').map(row=>[row.row,row.employeeCode,row.eventType,row.effectiveDate,row.status,row.errors.join('; ')]))]),'text/csv;charset=utf-8','movement-import-errors.csv');
 const changeCells=(row:MovementImportRow)=>{
  const fields=[...new Set([...Object.keys(row.before??{}),...Object.keys(row.proposed??{})])].filter(key=>key!=='companyName'&&row.before?.[key]!==row.proposed?.[key]);
  return <dl className="space-y-1 text-xs">{fields.map(key=><div key={key} className="grid gap-1 sm:grid-cols-[minmax(8rem,1fr)_1fr_1fr]"><dt className="font-medium">{fieldLabel(key)}</dt><dd className="break-words">{row.before?.[key]??'—'}</dd><dd className="break-words">{row.proposed?.[key]??'—'}</dd></div>)}</dl>;
 };
 return <section aria-label={t('title')} className="space-y-5" aria-busy={busy}>
  <Card className="space-y-4 p-5"><h2 className="font-medium">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('guidance')}</p><p className="text-xs text-muted-foreground">{t('sequenceHint')}</p>
   <p className="text-xs text-muted-foreground">{t('displacedHint')}</p><p className="text-xs text-muted-foreground">{t('dateHint')}</p><p className="text-xs text-muted-foreground">{t('limitsHint')}</p>
   <Field label={t('company')}><select className={inputCls} value={companyId} disabled={busy||!!result} onChange={event=>{if(pending.current)return;reset();setCompanyId(event.target.value);}}><option value="">{t('selectCompany')}</option>{companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></Field>
   <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={busy||!companyId} onClick={()=>void template()}>{t('downloadExcel')}</Button><Button type="button" variant="secondary" disabled={busy} onClick={()=>download(movementImportCsvTemplate(),'text/csv;charset=utf-8','movement-import-template.csv')}>{t('downloadCsv')}</Button></div>
   <Field label={t('file')}><input ref={input} type="file" accept=".csv,.xlsx,.xls" disabled={busy||!!result} className={inputCls} onChange={event=>{const file=event.target.files?.[0];if(file)void loadFile(file);}}/></Field>
   {fileName&&<p className="text-xs text-muted-foreground">{fileName}</p>}
   <Field label={t('csv')}><textarea className={inputCls+' min-h-32 font-mono text-xs'} value={csv} disabled={busy||!!result} onChange={event=>{if(pending.current)return;reset();setFileName('');setCsv(event.target.value);}} spellCheck={false}/></Field>
   <p className="text-xs text-muted-foreground">{t('blankHint')}</p>
   <Button type="button" disabled={busy||!csv.trim()||!companyId||!!result} onClick={()=>void doPreview()}>{busy?t('working'):t('check')}</Button>
  </Card>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!!preview?.fileErrors.length&&<div role="alert" className="rounded-lg border border-destructive p-4"><p>{t('fileRefused')}</p><ul>{preview.fileErrors.map((issue,index)=><li key={index} className="break-words text-sm">{issueText(issue)}</li>)}</ul></div>}
  {!!employees.length&&<Card className="space-y-4 p-5">
   <h2 className="font-medium">{result?t('resultTitle'):t('previewTitle')}</h2><p className="text-sm text-muted-foreground">{result?t('resultHint'):t('previewHint')}</p>
   <p role="status" className="text-sm">{result?t('resultCounts',{imported:result.imported,failed:result.failed,excluded:result.excluded}):t('previewCounts',{valid:preview!.valid,excluded:preview!.excluded})}</p>
   {employees.map(employee=><section key={employee.employeeCode} className="space-y-3 rounded-lg border p-3" aria-label={employee.employeeCode}>
    <h3 className="text-sm font-medium">{employee.employeeCode} · {employee.name??t('notFound')}</h3>
    {employee.rows.map(row=><div key={row.row} className="space-y-2 border-t pt-3">
     <div className="flex flex-wrap items-center gap-3">
      {!result&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy||row.status==='invalid'} checked={selection.includes(row.row)} onChange={event=>{if(pending.current)return;setSelection(value=>event.target.checked?[...value,row.row]:value.filter(number=>number!==row.row));setAcknowledge(false);}}/>{t('selectRow',{row:row.row})}</label>}
      <span className="text-sm font-medium">{eventLabel(row.eventType)}</span><span className="text-xs">{row.effectiveDate}</span><span className="text-xs">{t('rowStatus.'+row.status)}</span>{row.scheduled&&<span className="text-xs">{t('scheduled')}</span>}
     </div>
     {!!row.errors.length&&<ul className="text-xs text-destructive">{row.errors.map((issue,index)=><li key={index} className="break-words">{issueText(issue)}</li>)}</ul>}
     {!!row.payrollFlaggedPeriods?.length&&<p className="text-xs">{t('payrollWarning',{periods:row.payrollFlaggedPeriods.join(', ')})}</p>}
     {row.proposed&&<details><summary className="cursor-pointer text-xs font-medium">{t('compare')}</summary><div className="mt-2 grid grid-cols-3 text-xs font-medium"><span>{t('field')}</span><span>{t('current')}</span><span>{t('proposed')}</span></div>{changeCells(row)}</details>}
    </div>)}
    {result&&employee.employmentId&&<Link className="inline-block text-sm underline" href={'/admin/personnel/'+employee.employmentId+'?tab=careerMovement'}>{t('viewHistory')}</Link>}
   </section>)}
   {result?<><table className="w-full text-left text-xs"><thead><tr><th>{t('eventType')}</th><th>{t('rowStatus.imported')}</th><th>{t('rowStatus.failed')}</th><th>{t('rowStatus.excluded')}</th></tr></thead><tbody>{result.byEventType.map(count=><tr key={count.eventType}><td>{eventLabel(count.eventType)}</td><td>{count.imported}</td><td>{count.failed}</td><td>{count.excluded}</td></tr>)}</tbody></table><Button type="button" variant="secondary" onClick={()=>{reset();setCsv('');setFileName('');}}>{t('startAgain')}</Button></>:<>
    <p className="text-xs text-muted-foreground">{t('selectionHint')}</p>
    <Button type="button" variant="secondary" disabled={busy||!selection.length} onClick={()=>void doPreview(selection)}>{t('recheck')}</Button>
    {!!preview?.excluded&&<label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={busy} checked={acknowledge} onChange={event=>{if(!pending.current)setAcknowledge(event.target.checked);}}/>{t('excludeConfirmation',{count:preview.excluded})}</label>}
    <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy||!canCommit} onClick={()=>void apply()}>{busy?t('working'):t('confirm')}</Button><Button type="button" variant="secondary" onClick={errorDownload}>{t('downloadErrors')}</Button></div>
   </>}
   {result&&<Button type="button" variant="secondary" onClick={errorDownload}>{t('downloadErrors')}</Button>}
  </Card>}
 </section>;
}
