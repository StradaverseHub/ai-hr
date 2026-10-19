 'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import Link from 'next/link';
import {toCsv} from '@/lib/csv';
import {Button,Card,Field,inputCls} from '@/components/ui';
import {MOVEMENT_FORM_IDS} from '@/lib/movement-form-contract';
import {personnelFormLabel} from '@/lib/personnel-form-contract';
import {movementTypeCsvTemplate} from '@/lib/movement-type-csv';
import type {MovementImportPreview,MovementImportResult,MovementImportRow} from '@/lib/movement-import-contract';
import type {MovementImportCatalog,MovementImportFilters} from '@/core/movement-import';
import {movementCatalogAction} from './movement-actions';
function download(data:BlobPart,type:string,name:string){const url=URL.createObjectURL(new Blob([data],{type}));const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function MovementImport({companies,defaultCompanyId,onCommitPendingChange}:{companies:{id:string;name:string}[];defaultCompanyId:string;onCommitPendingChange?:(pending:boolean)=>void}){
 const t=useTranslations('people.import.movement'),labels=useTranslations();
 const word=(key:string,fallback:string)=>t.has('v2.'+key)?t('v2.'+key):fallback;
 const [companyId,setCompanyId]=useState(defaultCompanyId),[typeCode,setTypeCode]=useState(''),[mode,setMode]=useState<'one'|'all'>('one');
 const [catalog,setCatalog]=useState<MovementImportCatalog|null>(null),[filters,setFilters]=useState<MovementImportFilters>({});
 const [csv,setCsv]=useState(''),[file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<MovementImportPreview|null>(null),[result,setResult]=useState<MovementImportResult|null>(null);
 const [errorReceipt,setErrorReceipt]=useState('');
 const [selected,setSelected]=useState<string[]>([]),[acknowledge,setAcknowledge]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const revision=useRef(0),pending=useRef(false),input=useRef<HTMLInputElement>(null),summary=useRef<HTMLDivElement>(null);
 const resolver=(key:string,fallback:string)=>labels.has(key)?labels(key):fallback;
 const fieldLabel=(key:string)=>key in MOVEMENT_FORM_IDS?personnelFormLabel(MOVEMENT_FORM_IDS[key as keyof typeof MOVEMENT_FORM_IDS],resolver):t.has('currentFields.'+key)?t('currentFields.'+key):key;
 const eventLabel=(code:string)=>{const type=catalog?.types.find(v=>v.code===code);return type?.label??resolver('people.detail.movement.eventType.'+(type?.behaviour??code),code);};
 const issueText=(issue:string)=>issue.split('; ').map(part=>{const [code,...detail]=part.split(':');return t.has('issues.'+code)?t('issues.'+code)+(detail.length?' · '+fieldLabel(detail.join(':')):''):word('refused','This change could not be applied. Correct the highlighted field and check the complete sequence again.')+(detail.length?' · '+fieldLabel(detail[0]):'');}).join('; ');
 const reset=()=>{revision.current++;setPreview(null);setResult(null);setSelected([]);setAcknowledge(false);setError(null);setErrorReceipt('');};
 const resetContext=()=>{reset();setFile(null);setCsv('');if(input.current)input.current.value='';};
 useEffect(()=>{let active=true;setCatalog(null);if(companyId)void movementCatalogAction(companyId).then(value=>{if(active)setCatalog(value);}).catch(()=>{if(active)setError(t('templateFailed'));});return()=>{active=false;};},[companyId]);
 useEffect(()=>()=>{revision.current++;},[]);
 const selectedType=catalog?.types.find(type=>type.code===typeCode);
 const makeForm=(operation:string)=>{const body=new FormData();body.set('operation',operation);body.set('companyId',companyId);body.set('typeCode',typeCode);body.set('filters',JSON.stringify(filters));if(operation==='errors'&&errorReceipt)body.set('errorReceipt',errorReceipt);if(file)body.set('file',file);else body.set('csv',csv);return body;};
 const run=async(operation:'preview'|'apply'|'download'|'errors')=>{
  if(operation==='errors'&&(!file||!file.name.toLowerCase().endsWith('.xlsx'))){const employees=result?.employees??preview?.employees??[];download(toCsv([[word('sheet','Tab'),t('row'),t('employeeId'),t('eventType'),t('errors')],...employees.flatMap(e=>e.rows.filter(r=>r.status!=='imported'&&r.status!=='valid').map(r=>[r.source?.sheet??'CSV',r.source?.row??r.row,r.employeeCode,eventLabel(r.eventType),r.errors.map(issueText).join('; ')]))]),'text/csv;charset=utf-8','movement-import-errors.csv');return;}
  if(pending.current)return;pending.current=true;setBusy(true);setError(null);const current=revision.current;
  if(operation==='apply')onCommitPendingChange?.(true);
  if(operation==='preview'){setPreview(null);setResult(null);setSelected([]);setAcknowledge(false);}
  try{
   const body=makeForm(operation);if(operation==='download'&&mode==='all')body.set('typeCode','');
   if(operation==='apply'&&preview){body.set('selection',JSON.stringify(preview.employees.filter(e=>selected.includes(e.employeeCode)).flatMap(e=>e.rows.map(r=>r.row))));body.set('inputHash',preview.inputHash);body.set('fingerprints',JSON.stringify(Object.fromEntries(preview.employees.filter(e=>e.fingerprint).map(e=>[e.employeeCode,e.fingerprint]))));body.set('acknowledgeExcluded',String(acknowledge));}
   const response=await fetch('/admin/personnel/import/movement',{method:'POST',body});
   if(current!==revision.current)return;
   if(response.ok&&response.headers.get('content-type')?.includes('spreadsheetml')){download(await response.arrayBuffer(),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',operation==='errors'?'movement-import-errors.xlsx':'movement-import.xlsx');return;}
   const value=await response.json();if(!response.ok||!value.ok){setError(issueText(value.error??'change_refused'));return;}
   if(value.preview){setPreview(value.preview);setResult(null);setSelected(value.preview.employees.filter((e:MovementImportPreview['employees'][number])=>e.fingerprint&&e.rows.every(r=>r.status==='valid')).map((e:MovementImportPreview['employees'][number])=>e.employeeCode));setAcknowledge(false);requestAnimationFrame(()=>summary.current?.focus());}
   if(value.result){setResult(value.result);setErrorReceipt(value.errorReceipt??'');requestAnimationFrame(()=>summary.current?.focus());}
  }catch{if(current===revision.current)setError(operation==='apply'?t('applyFailed'):t('checkFailed'));}
  finally{pending.current=false;setBusy(false);if(operation==='apply')onCommitPendingChange?.(false);}
 };
 const employees=result?.employees??preview?.employees??[];
 const groups=new Map<string,MovementImportRow[]>();for(const employee of employees)for(const row of employee.rows)groups.set(row.eventType,[...(groups.get(row.eventType)??[]),row]);
 const excludedEmployees=preview?.employees.filter(e=>!selected.includes(e.employeeCode)).length??0;
 const canCommit=!!preview&&!result&&!preview.fileErrors.length&&selected.length>0&&(!excludedEmployees||acknowledge);
 const compare=(row:MovementImportRow)=>{const fields=[...new Set([...Object.keys(row.before??{}),...Object.keys(row.proposed??{})])].filter(key=>key!=='companyName'&&row.before?.[key]!==row.proposed?.[key]);return <dl className="space-y-1 text-xs">{fields.map(key=><div key={key} className="grid gap-1 sm:grid-cols-[minmax(8rem,1fr)_1fr_1fr]"><dt className="font-medium">{fieldLabel(key)}</dt><dd className="break-words">{row.before?.[key]??'—'}</dd><dd className="break-words">{row.proposed?.[key]??'—'}</dd></div>)}</dl>;};
 const filterFields=[['departmentIds','departmentId','department','Department'],['businessUnitIds','businessUnitId','businessUnit','Business unit'],['gradeIds','gradeId','grade','Job grade'],['locationIds','locationId','location','Location']] as const;
 return <section aria-label={t('title')} className="space-y-5" aria-busy={busy}>
  <Card className="space-y-4 p-5"><h2 className="font-medium">{t('title')}</h2><p className="text-sm text-muted-foreground">{word('workbookHint','Grey shows current records, yellow your entries and green calculations. Pay and current records are checked again before saving.')}</p>
   <Field label={t('company')}><select className={inputCls} value={companyId} disabled={busy||!!result} onChange={e=>{resetContext();setCompanyId(e.target.value);setTypeCode('');setFilters({});}}><option value="">{t('selectCompany')}</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
   <div className="grid gap-3 sm:grid-cols-2"><Field label={word('download','Download workbook')}><select className={inputCls} value={mode} disabled={busy} onChange={e=>setMode(e.target.value as 'one'|'all')}><option value="one">{word('oneType','One type with employees')}</option><option value="all">{word('allTypes','All active types — blank workbook')}</option></select></Field>
   <Field label={word('type','Movement type')}><select className={inputCls} value={typeCode} disabled={busy||!catalog||!!result} onChange={e=>{resetContext();setTypeCode(e.target.value);setFilters({});}}><option value="">{word('singleTypeRequired','Choose one type for CSV and pasted CSV.')}</option>{catalog?.types.map(type=><option key={type.code} value={type.code}>{eventLabel(type.code)}</option>)}</select></Field></div>
   {mode==='one'&&selectedType&&<fieldset className="space-y-3 rounded-lg border p-3"><legend className="px-1 text-sm font-medium">{word('filters','Filter employees')}</legend><div className="grid gap-3 sm:grid-cols-2">{filterFields.map(([key,field,caption,fallback])=><Field key={key} label={word(caption,fallback)}><select multiple className={inputCls+' min-h-24'} value={filters[key]??[]} disabled={busy} onChange={e=>setFilters(f=>({...f,[key]:Array.from(e.target.selectedOptions,o=>o.value)}))}>{catalog?.fields[field]?.map(value=><option key={value.value} value={value.value}>{value.label}</option>)}</select></Field>)}</div>
    {['confirmation','probationExtension'].includes(selectedType.behaviour)&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.probationOnly??false} disabled={busy} onChange={e=>setFilters(f=>({...f,probationOnly:e.target.checked}))}/>{word('probationOnly','Only employees on probation')}</label>}
    <p className="text-xs text-muted-foreground">{word('employedScope','Employees on probation or serving notice remain included. Ended or blacklisted employments are excluded from prefill.')}</p>
    <p className="text-xs text-muted-foreground">{word('limit','At most 50 employees and 200 entered events. Narrow the filters; no employee is silently omitted.')}</p></fieldset>}
   <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={busy||!companyId||!catalog?.types.length||mode==='one'&&!selectedType} onClick={()=>void run('download')}>{t('downloadExcel')}</Button><Button type="button" variant="secondary" disabled={busy||!selectedType} onClick={()=>{if(selectedType)download(movementTypeCsvTemplate(selectedType,resolver),'text/csv;charset=utf-8','movement-import-'+selectedType.code+'.csv');}}>{t('downloadCsv')}</Button></div>
   <p className="text-xs text-muted-foreground">{word('contextHint','Company and one selected type apply to CSV and pasted CSV. Changing them clears the file and preview.')}</p>
   <Field label={t('file')}><input ref={input} type="file" accept=".csv,.xlsx" disabled={busy||!!result} className={inputCls} onChange={e=>{reset();setFile(e.target.files?.[0]??null);setCsv('');}}/></Field>
   {file&&<p className="text-xs text-muted-foreground">{file.name}</p>}
   <Field label={t('csv')}><textarea className={inputCls+' min-h-32 font-mono text-xs'} value={csv} disabled={busy||!!result} onChange={e=>{reset();setFile(null);if(input.current)input.current.value='';setCsv(e.target.value);}} spellCheck={false}/></Field>
   <Button type="button" disabled={busy||!companyId||!file&&!csv.trim()||(!file||file.name.toLowerCase().endsWith('.csv'))&&!selectedType||!!result} onClick={()=>void run('preview')}>{busy?t('working'):t('check')}</Button>
  </Card>
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {!!preview?.fileErrors.length&&<div role="alert" className="rounded-lg border border-destructive p-4"><p>{t('fileRefused')}</p><ul>{preview.fileErrors.map((issue,i)=><li key={i} className="text-sm">{issueText(issue)}</li>)}</ul></div>}
  {!!employees.length&&<Card className="space-y-4 p-5"><div ref={summary} tabIndex={-1} className="outline-none"><h2 className="font-medium">{result?t('resultTitle'):t('previewTitle')}</h2><p role="status" className="text-sm">{result?t('resultCounts',{imported:result.imported,failed:result.failed,excluded:result.excluded}):t('previewCounts',{valid:preview!.valid,excluded:preview!.excluded})}</p></div>
   <p className="text-sm text-muted-foreground">{word('wholeEmployee','Each employee’s complete sequence is included or excluded together.')}</p>
   {[...groups].map(([type,rows])=><details key={type} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{eventLabel(type)} · {rows.length}</summary><div className="mt-3 space-y-3">{rows.map(row=><div key={row.row} className="space-y-2 border-t pt-2"><p className="text-sm font-medium">{row.employeeCode} · {row.source?.sheet??'CSV'} · {t('row')} {row.source?.row??row.row} · {row.effectiveDate} · {t('rowStatus.'+row.status)}</p>{row.errors.length>0&&<ul className="text-xs text-destructive">{row.errors.map((error,i)=><li key={i}>{issueText(error)}</li>)}</ul>}{!!row.warnings?.length&&<ul className="text-xs text-amber-700 dark:text-amber-400" aria-label={word('warnings','Warnings')}>{row.warnings.map((warning,i)=><li key={i}>{issueText(warning)}</li>)}</ul>}{row.proposed&&<><div className="grid grid-cols-3 text-xs font-medium"><span>{t('field')}</span><span>{t('current')}</span><span>{t('proposed')}</span></div>{compare(row)}</>}</div>)}</div></details>)}
   {employees.map(employee=><section key={employee.employeeCode} className="space-y-2 rounded-lg border p-3"><h3 className="text-sm font-medium">{employee.employeeCode} · {employee.name??t('notFound')}</h3>
    {!result&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy||!employee.fingerprint||employee.rows.some(r=>r.status!=='valid')} checked={selected.includes(employee.employeeCode)} onChange={e=>{setSelected(current=>e.target.checked?[...current,employee.employeeCode]:current.filter(c=>c!==employee.employeeCode));setAcknowledge(false);}}/>{word('included','Include employee')}</label>}
    <details><summary className="cursor-pointer text-xs font-medium">{word('sequence','Complete employee sequence')}</summary><ol className="mt-2 list-inside list-decimal text-xs">{employee.rows.map(row=><li key={row.row}>{row.effectiveDate} · {eventLabel(row.eventType)} · {row.source?.sheet??'CSV'} / {row.source?.row??row.row}</li>)}</ol></details>
    {result&&employee.employmentId&&<Link className="text-sm underline" href={'/admin/personnel/'+employee.employmentId+'?tab=careerMovement'}>{t('viewHistory')}</Link>}
   </section>)}
   {result?<><table className="w-full text-left text-xs"><thead><tr><th>{t('eventType')}</th><th>{t('rowStatus.imported')}</th><th>{t('rowStatus.failed')}</th><th>{t('rowStatus.excluded')}</th></tr></thead><tbody>{result.byEventType.map(count=><tr key={count.eventType}><td>{eventLabel(count.eventType)}</td><td>{count.imported}</td><td>{count.failed}</td><td>{count.excluded}</td></tr>)}</tbody></table>{result.batchId&&result.imported>0&&<Link className="block text-sm underline" href={'/admin/audit?record='+result.batchId}>{word('audit','View import audit')}</Link>}<Button type="button" variant="secondary" onClick={()=>{reset();setCsv('');setFile(null);if(input.current)input.current.value='';}}>{t('startAgain')}</Button></>:<>
    {excludedEmployees>0&&<label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={busy} checked={acknowledge} onChange={e=>setAcknowledge(e.target.checked)}/>{t('excludeConfirmation',{count:preview!.employees.filter(e=>!selected.includes(e.employeeCode)).reduce((n,e)=>n+e.rows.length,0)})}</label>}
    <Button type="button" disabled={busy||!canCommit} onClick={()=>void run('apply')}>{busy?t('working'):t('confirm')}</Button>
   </>}
   <Button type="button" variant="secondary" disabled={busy} onClick={()=>void run('errors')}>{word('errorWorkbook','Download annotated errors')}</Button>
  </Card>}
 </section>;
}
