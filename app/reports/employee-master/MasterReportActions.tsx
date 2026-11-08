'use client';
import Link from 'next/link';
import { useExportDownload } from '@/components/use-export-download';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { deleteEmployeeMaster, duplicateEmployeeMaster } from './actions';
export function MasterReportActions({id,canEdit}:{id:string;canEdit:boolean}){
 const t=useTranslations('employeeMasterReports'),router=useRouter(),[pending,start]=useTransition(),[error,setError]=useState('');
 const button='rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-40';
 const downloadFeedback = useExportDownload();
 async function download() {
  setError('');
  const url = new URL('/reports/employee-master/export', location.href);
  if (await downloadFeedback.download(url, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ id, format: 'xlsx' }),
  })) router.refresh();
 }
 return <div><div className="flex flex-wrap gap-1"><Link className={button} href={'/reports/employee-master/'+id}>{t('runSavedReport')}</Link>{canEdit&&<Link className={button} href={'/reports/employee-master/'+id}>{t('editSavedReport')}</Link>}<button aria-busy={pending} type="button" className={button} disabled={pending} onClick={()=>start(async()=>{const response=await duplicateEmployeeMaster(id);if(response.ok){router.push('/reports/employee-master/'+response.id);router.refresh();}else setError(response.error);})}>{t('duplicate')}</button><button type="button" className={button} disabled={downloadFeedback.pending} aria-busy={downloadFeedback.pending} onClick={download}>{t('export')} Excel</button><span className="sr-only" role="status">{downloadFeedback.status}</span>{canEdit&&<button aria-busy={pending} type="button" className={button} disabled={pending} onClick={()=>{if(!window.confirm(t('deleteConfirm')))return;start(async()=>{const response=await deleteEmployeeMaster(id);if(response.ok)router.refresh();else setError(response.error);});}}>{t('delete')}</button>}</div>{error&&<p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}</div>;
}
