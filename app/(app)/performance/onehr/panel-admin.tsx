'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { panelImportHeaders } from '@/packs/performance/onehr/panel-build-model';
import { Button, Card, ErrorBanner, Field, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { assessmentPanelsBuildAction, assessmentPanelsImportAction } from '../onehr-actions';

export function PanelAdmin({cycleId}:{cycleId:string}){
 const t=useTranslations('onehr.panelAdmin'),common=useTranslations('onehr'),imports=useTranslations('onehr.imports'),router=useRouter();
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>();
 const [mode,setMode]=useState<'missing'|'topup'>('missing'),[build,setBuild]=useState<Awaited<ReturnType<typeof assessmentPanelsBuildAction>>['result']>();
 const [importMode,setImportMode]=useState<'add'|'replace'>('add'),[csv,setCsv]=useState(''),[preview,setPreview]=useState<Awaited<ReturnType<typeof assessmentPanelsImportAction>>['result']>();
 async function generate(apply=false){
  if(busy||apply&&(!build||build.applied))return;setBusy(true);setError(undefined);
  try{const response=await assessmentPanelsBuildAction(cycleId,mode,apply?build?.token:undefined);if(response.error){setError(response.error);setBuild(undefined);}else{setBuild(response.result);if(response.result?.applied){setPreview(undefined);router.refresh();}}}catch{setError(imports('readError'));}finally{setBusy(false);}
 }
 async function file(file:File|undefined){
  setCsv('');setPreview(undefined);setError(undefined);if(!file)return;if(file.size>10_000_000){setError(imports('tooLarge'));return;}
  setBusy(true);try{setCsv(/\.csv$/i.test(file.name)?await file.text():await (await import('@/lib/spreadsheet')).workbookToCsvText(await file.arrayBuffer()));}catch{setError(imports('readError'));}finally{setBusy(false);}
 }
 async function run(apply=false){
  if(busy||!csv||apply&&(!preview||preview.applied))return;setBusy(true);setError(undefined);
  try{const response=await assessmentPanelsImportAction(cycleId,csv,importMode,apply?preview?.token:undefined);if(response.error){setError(response.error);setPreview(undefined);}else{setPreview(response.result);if(response.result?.applied){setBuild(undefined);router.refresh();}}}catch{setError(imports('readError'));}finally{setBusy(false);}
 }
 async function template(){
  setBusy(true);setError(undefined);try{
   const bytes=await (await import('@/lib/spreadsheet')).buildXlsx(panelImportHeaders,[],{sheetName:'Assessor panels',textColumns:[0,1]});const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const a=document.createElement('a');a.href=url;a.download='assessor-panel-template.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch{setError(imports('readError'));}finally{setBusy(false);}
 }
 return <Card className="space-y-5 p-5"><h2 className="font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('help')}</p><ErrorBanner message={error}/>
  <details><summary className="cursor-pointer font-medium">{t('build')}</summary><div className="mt-4 space-y-4"><p className="text-sm text-muted-foreground">{t('buildHelp')}</p><div className="flex flex-wrap items-end gap-3"><Field label={t('mode')}><select value={mode} disabled={busy} onChange={e=>{setMode(e.target.value as typeof mode);setBuild(undefined);}} className={inputCls}>{['missing','topup'].map(m=><option key={m} value={m}>{t(m)}</option>)}</select></Field><Button type="button" disabled={busy} onClick={()=>void generate()}>{t('preview')}</Button></div>
   {build&&<>{build.applied&&<p role="status" className="font-medium">{t('applied')}</p>}<div className="max-h-96 overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{[common('employee'),t('status'),t('before'),t('after'),t('target'),t('assessors')].map(h=><th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{build.rows.map(r=><tr key={r.reviewId} className="border-t border-border"><td className="p-2">{r.name}<span className="block text-xs text-muted-foreground">{r.code}</span></td><td className="p-2">{t(`statuses.${r.status}`)}</td><td className="p-2">{r.before}</td><td className="p-2">{r.after}</td><td className="p-2">{r.target}</td><td className="p-2"><ul>{r.add.map(m=><li key={m.employmentId}>{m.name} · {common(`relationships.${m.relationship}`)}</li>)}</ul></td></tr>)}</tbody></table></div>{!build.applied&&build.rows.some(r=>r.add.length)&&<form onSubmit={e=>{e.preventDefault();void generate(true);}}><ConfirmSubmit disabled={busy} description={t('confirm')}>{t('apply')}</ConfirmSubmit></form>}</>}
  </div></details>
  <details><summary className="cursor-pointer font-medium">{t('import')}</summary><div className="mt-4 space-y-4"><p className="text-sm text-muted-foreground">{t('importHelp')}</p><div className="flex flex-wrap items-end gap-3"><Field label={t('mode')}><select value={importMode} disabled={busy} onChange={e=>{setImportMode(e.target.value as typeof importMode);setPreview(undefined);}} className={inputCls}>{['add','replace'].map(m=><option key={m} value={m}>{t(m)}</option>)}</select></Field><Field label={imports('file')}><input type="file" accept=".csv,.xls,.xlsx" disabled={busy} onChange={e=>void file(e.target.files?.[0])}/></Field><Button type="button" variant="secondary" disabled={busy} onClick={()=>void template()}>{imports('template')}</Button><Button type="button" disabled={busy||!csv} onClick={()=>void run()}>{t('preview')}</Button></div>
   {preview&&<>{preview.applied&&<p role="status" className="font-medium">{t('applied')}</p>}<div className="max-h-96 overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{[common('employee'),t('after'),t('created'),t('updated'),t('restored'),t('archived')].map(h=><th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{preview.rows.map(r=><tr key={r.reviewId} className="border-t border-border"><td className="p-2">{r.name}<span className="block text-xs text-muted-foreground">{r.code}</span></td><td className="p-2">{r.count}</td><td className="p-2">{r.created}</td><td className="p-2">{r.updated}</td><td className="p-2">{r.restored}</td><td className="p-2">{r.archived}</td></tr>)}</tbody></table></div>{!preview.applied&&preview.rows.length>0&&<form onSubmit={e=>{e.preventDefault();void run(true);}}><ConfirmSubmit disabled={busy} description={t('confirm')}>{t('apply')}</ConfirmSubmit></form>}</>}
  </div></details>
 </Card>;
}
