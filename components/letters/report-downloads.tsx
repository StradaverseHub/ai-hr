'use client';
import {useState} from 'react';
import {toast} from 'sonner';
import {btnGhost} from '@/components/ui';
export function LetterReportDownloads({query,labels}:{query:string;labels:{excel:string;pdf:string;working:string;errors:Record<string,string>}}){
 const [working,setWorking]=useState<'xlsx'|'pdf'|null>(null),[error,setError]=useState<string|null>(null);
 async function download(format:'xlsx'|'pdf'){
  setWorking(format);setError(null);
  try{const response=await fetch(`/letters/reports/export?${query}&format=${format}`,{cache:'no-store'});if(!response.ok){if(response.status===401||response.status===403){setError(labels.errors.permission);return;}const result=await response.json().catch(()=>({error:'unavailable'}));setError(typeof result.error==='string'&&Object.hasOwn(labels.errors,result.error)?labels.errors[result.error]:labels.errors.unavailable);return;}
   const expected=format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';if(response.headers.get('content-type')?.split(';')[0]!==expected){setError(response.redirected?labels.errors.permission:labels.errors.unavailable);return;}
   const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='letters-report.'+format;document.body.appendChild(link);link.click();link.remove();toast.success(link.download);setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch{setError(labels.errors.unavailable);}finally{setWorking(null);}
 }
 return <div className="space-y-3"><div className="flex flex-wrap gap-3"><button type="button" className={`${btnGhost} min-h-11 disabled:opacity-50`} disabled={working!==null} aria-busy={working==='xlsx'} data-action-pending={working==='xlsx'||undefined} onClick={()=>download('xlsx')}>{working==='xlsx'?labels.working:labels.excel}</button><button type="button" className={`${btnGhost} min-h-11 disabled:opacity-50`} disabled={working!==null} aria-busy={working==='pdf'} data-action-pending={working==='pdf'||undefined} onClick={()=>download('pdf')}>{working==='pdf'?labels.working:labels.pdf}</button></div>{error&&<p role="alert" className="max-w-prose text-sm text-destructive">{error}</p>}</div>;
}
