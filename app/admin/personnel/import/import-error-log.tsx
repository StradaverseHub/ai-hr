'use client';
/**
 * Board d3ba1e9f — the problem list and the "Download Error Log" button of the Personnel Management imports. Both
 * are drawn from the SAME ImportProblemLine rows (built once by the import's adapter), so what the screen says and
 * what the downloaded .xlsx says cannot differ. The workbook is built in the browser from those rows; its writer is
 * loaded only when the button is pressed.
 */
import {useMemo,useState} from 'react';
import {useTranslations} from 'next-intl';
import {ImportProblemTable} from '@/components/import-problem-table';
import type {ImportProblemLine} from '@/lib/import-problem-lines';
import type {ImportProblemTranslate} from '@/lib/import-problem-common';

/** The adapter translators on the client: the root translator and the shared importProblems vocabulary. */
export function useImportProblemTranslate():ImportProblemTranslate{
 const root=useTranslations(),shared=useTranslations('importProblems');
 return useMemo(()=>({problems:(key,values)=>root(key as never,values as never),shared:key=>shared(key as never)}),[root,shared]);
}

/** File name of a downloaded Error Log: `<source name>-error-log.xlsx`, safe for every file system. */
export function errorLogFileName(source:string|null|undefined){
 const base=(source??'').replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|\u0000-\u001f]+/g,'_').trim().slice(0,80);
 return `${base||'import'}-error-log.xlsx`;
}

export function ImportErrorLogButton({lines,fileName,className}:{lines:readonly ImportProblemLine[];fileName?:string|null;className?:string}){
 const t=useTranslations('importProblems'),own=useTranslations('importErrorLogEmployee');
 const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
 if(lines.length===0)return null;
 const download=async()=>{
  setBusy(true);setFailed(false);
  try{
   const {importProblemWorkbook}=await import('@/lib/import-problem-workbook');
   const bytes=importProblemWorkbook({lines,t,summary:[
    [t('summary.file'),fileName||'—'],[t('summary.problems'),lines.length],
   ]});
   const url=URL.createObjectURL(new Blob([bytes as BlobPart],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
   const a=document.createElement('a');a.href=url;a.download=errorLogFileName(fileName);a.click();URL.revokeObjectURL(url);
  }catch{setFailed(true);}
  finally{setBusy(false);}
 };
 return <span className="inline-flex flex-col items-start gap-1">
  <button type="button" onClick={()=>void download()} disabled={busy} aria-busy={busy}
   className={className??'rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-60'}>{t('downloadLog')}</button>
  {failed&&<span role="alert" className="text-xs text-destructive">{own('downloadFailed')}</span>}
 </span>;
}

/** The problem table and, beside its heading, the Error Log download. Renders nothing when there is no problem. */
export function ImportProblems({lines,fileName,title}:{lines:readonly ImportProblemLine[];fileName?:string|null;title?:string}){
 if(lines.length===0)return null;
 return <div className="space-y-2 border-b border-border px-4 py-3" data-import-problems="">
  <div className="flex flex-wrap items-center justify-between gap-2">
   {title?<p className="text-sm font-semibold text-red-700 dark:text-red-400">{title}</p>:<span/>}
   <ImportErrorLogButton lines={lines} fileName={fileName}/>
  </div>
  <ImportProblemTable lines={lines} caption={title}/>
 </div>;
}
