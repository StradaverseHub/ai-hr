'use client';
/**
 * Board d3ba1e9f — the on-screen problem list plus its "Download Error Log" for an import whose lines are already in
 * the browser (Cost Center Allocations, Information-Only Correction). The download is built here from the SAME lines
 * the table shows (importProblemWorkbook, loaded only when asked for), so the file and the screen match.
 */
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {ImportProblemTable} from '@/components/import-problem-table';
import type {ImportProblemLine} from '@/lib/import-problem-lines';

export function ErrorLogDownloadButton({lines,fileName,sourceName,batch}:{lines:readonly ImportProblemLine[];fileName:string;sourceName?:string;batch?:string}){
 const t=useTranslations('importProblems');
 const [busy,setBusy]=useState(false);
 const download=async()=>{
  setBusy(true);
  try{
   const {importProblemWorkbook}=await import('@/lib/import-problem-workbook');
   const summary:[string,string|number][]=[...(batch?[[t('summary.batch'),batch] as [string,string]]:[]),...(sourceName?[[t('summary.file'),sourceName] as [string,string]]:[]),[t('summary.problems'),lines.length]];
   const bytes=importProblemWorkbook({lines,t,summary});
   const url=URL.createObjectURL(new Blob([bytes as BlobPart],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
   const a=document.createElement('a');a.href=url;a.download=fileName;a.click();URL.revokeObjectURL(url);
  }finally{setBusy(false);}
 };
 return <Button type="button" variant="outline" aria-busy={busy} disabled={busy||!lines.length} onClick={()=>void download()}>{t('downloadLog')}</Button>;
}

export function ImportProblemsWithDownload({lines,fileName,sourceName,batch}:{lines:readonly ImportProblemLine[];fileName:string;sourceName?:string;batch?:string}){
 const t=useTranslations('importProblems');
 if(!lines.length)return null;
 return <div className="space-y-2" data-import-problems>
  <ImportProblemTable lines={lines} caption={t('downloadLog')}/>
  <ErrorLogDownloadButton lines={lines} fileName={fileName} sourceName={sourceName} batch={batch}/>
 </div>;
}
