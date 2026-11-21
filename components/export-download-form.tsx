'use client';
import type {FormHTMLAttributes} from 'react';
import {useExportDownload} from './use-export-download';

/** Browser-managed file saving cannot be confirmed; wait for complete attachment bytes before handoff. */
export function ExportDownloadForm({action,children,...props}:Omit<FormHTMLAttributes<HTMLFormElement>,'action'|'onSubmit'|'method'>&{action:string}){
 const {download,pending,status}=useExportDownload();
 return <form {...props} action={action} method="post" aria-busy={pending} onSubmit={event=>{
  event.preventDefault();if(pending)return;
  const form=event.currentTarget,submitter=(event.nativeEvent as SubmitEvent).submitter;
  const data=new FormData(form,submitter);void download(new URL(action,location.href),{method:'POST',body:data});
 }}><fieldset disabled={pending} className="contents">{children}</fieldset>{pending&&<span className="inline-flex items-center gap-2" role="status"><span className="action-spinner" aria-hidden="true"/>{status}</span>}</form>;
}
