'use client';

import {useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from './ui';

/** The server owns scope, workbook construction and authorization; no spreadsheet library enters the client. */
export function SystemLabelExportButton({kind}:{kind:string}){
  const t=useTranslations('systemLabelExchange');
  const [pending,start]=useTransition(),[error,setError]=useState('');
  return <span className="inline-flex flex-col gap-1">
    <Button aria-busy={pending} type="button" variant="outline" size="sm" disabled={pending} onClick={()=>start(async()=>{
      setError('');
      try{
        const response=await fetch(`/admin/settings/system-labels/current-data?kind=${encodeURIComponent(kind)}&inactive=1`,{cache:'no-store'});
        if(!response.ok||!response.headers.get('Content-Type')?.includes('spreadsheetml')){
          // The route returns its refusal as a plain, public sentence (publicErrorMessage); show it rather than a bare "failed".
          const json=!response.ok&&response.headers.get('Content-Type')?.includes('application/json');
          const reason=json?await response.json().then((body:unknown)=>typeof (body as {error?:unknown})?.error==='string'?(body as {error:string}).error:'').catch(()=>''):'';
          setError(reason||t('failed'));return;
        }
        const url=URL.createObjectURL(await response.blob());
        const link=document.createElement('a');link.href=url;link.download=`system-labels-${kind}.xlsx`;document.body.appendChild(link);link.click();link.remove();
        // Allow the browser to start consuming the download before releasing its object URL.
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      }catch{setError(t('failed'));}
    })}>{pending?t('exporting'):t('export')}</Button>
    {error&&<span role="alert" className="max-w-64 text-xs text-destructive">{error}</span>}
  </span>;
}
