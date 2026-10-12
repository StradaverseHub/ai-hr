'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, ErrorBanner, Field, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { kpiLibraryImportHeaders, kpiTargetImportHeaders } from '@/packs/performance/onehr/import-model';
import { assessmentKpiImportAction } from '../onehr-actions';

type Kind='targets'|'library';
type Result=NonNullable<Awaited<ReturnType<typeof assessmentKpiImportAction>>['result']>;

export function AssessmentKpiImport({cycleId}:{cycleId:string}) {
 const t=useTranslations('onehr.imports'),router=useRouter();
 const [kind,setKind]=useState<Kind>('targets'),[csv,setCsv]=useState(''),[result,setResult]=useState<Result|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|undefined>();
 const fileRef=useRef<HTMLInputElement>(null);
 async function selectFile(file:File|undefined) {
  setCsv('');setResult(null);setError(undefined);if(!file)return;
  if(file.size>10_000_000){setError(t('tooLarge'));return;}
  setBusy(true);
  try {
   if(/\.csv$/i.test(file.name))setCsv(await file.text());
   else if(/\.xlsx?$/i.test(file.name))setCsv(await (await import('@/lib/spreadsheet')).workbookToCsvText(await file.arrayBuffer()));
   else setError(t('unsupported'));
  }catch{setError(t('readError'));}finally{setBusy(false);}
 }
 async function run(apply:boolean) {
  if(busy||!csv||apply&&(!result||result.errors.length||result.applied))return;
  setBusy(true);setError(undefined);
  try {
   const response=await assessmentKpiImportAction(cycleId,csv,kind,apply?result!.token:undefined);
   if(response.error){setError(response.error);if(apply)setResult(null);}
   else if(response.result){setResult(response.result);if(response.result.applied)router.refresh();}
  }catch{setError(t('readError'));}finally{setBusy(false);}
 }
 async function template() {
  setBusy(true);setError(undefined);
  try {
   const headers=kind==='targets'?kpiTargetImportHeaders:kpiLibraryImportHeaders;
   const bytes=await (await import('@/lib/spreadsheet')).buildXlsx(headers,[],{sheetName:'KPI import',textColumns:kind==='targets'?[0,headers.indexOf('Matrix manager ID')]:[4]});
   const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
   const link=document.createElement('a');link.href=url;link.download=`performance-${kind}-template.xlsx`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch{setError(t('readError'));}finally{setBusy(false);}
 }
 return <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('help')}</p><ErrorBanner message={error}/>
  <div className="flex flex-wrap items-end gap-4"><Field label={t('kind')}><select disabled={busy} value={kind} className={inputCls} onChange={e=>{setKind(e.target.value as Kind);setResult(null);setCsv('');if(fileRef.current)fileRef.current.value='';}}><option value="targets">{t('targets')}</option><option value="library">{t('library')}</option></select></Field><Field label={t('file')}><input ref={fileRef} disabled={busy} type="file" accept=".csv,.xls,.xlsx" onChange={e=>void selectFile(e.target.files?.[0])}/></Field><Button type="button" variant="secondary" disabled={busy} onClick={()=>void template()}>{t('template')}</Button><Button type="button" disabled={busy||!csv} onClick={()=>void run(false)}>{t(busy?'busy':'preview')}</Button></div>
  {result&&<><div role="status" className="flex flex-wrap gap-4 text-sm"><span>{t('created',{count:result.created})}</span><span>{t('updated',{count:result.updated})}</span><span>{t('skipped',{count:result.skipped})}</span>{result.applied&&<strong>{t('done')}</strong>}</div>
   {result.errors.length>0&&<ul role="alert" className="max-h-60 list-disc overflow-auto pl-5 text-sm text-destructive">{result.errors.map((e,i)=><li key={i}>{e}</li>)}</ul>}
   <div className="max-h-96 overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{['row','subject','kpi','action','note'].map(k=><th key={k} className="p-2">{t(k)}</th>)}</tr></thead><tbody>{result.preview.map(r=><tr key={r.row} className="border-t border-border"><td className="p-2">{r.row}</td><td className="p-2">{r.subject}</td><td className="p-2">{r.title}</td><td className="p-2">{t(r.action)}</td><td className="p-2">{r.note}</td></tr>)}</tbody></table></div>
   {!result.applied&&result.errors.length===0&&result.created+result.updated>0&&<form onSubmit={e=>{e.preventDefault();void run(true);}}><ConfirmSubmit variant="default" disabled={busy} title={t('apply')} description={t('confirm')}>{t('apply')}</ConfirmSubmit></form>}
  </>}
 </Card>;
}
