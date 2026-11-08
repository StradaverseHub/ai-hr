'use client';
import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {TESTING_LIMITS} from '@/lib/system-testing/model';
import {btnPrimary,inputCls} from '@/components/ui';
import {ActionButton} from '@/components/ui/action-button';
import {ActionFeedback,useActionFeedback,useActionFeedbackLabels} from '@/components/action-feedback';

export function TestingScreenshotUpload({executionId,runId,limitReached=false}:{executionId:string;runId:string;limitReached?:boolean}){
 const t=useTranslations('systemTestingWorkspace'),router=useRouter(),labels=useActionFeedbackLabels();
 const feedback=useActionFeedback({kind:'uploading'}),inFlight=useRef(false);
 const [error,setError]=useState<'uploadInvalid'|null>(null);
 return <form className="space-y-3" onSubmit={async event=>{
  event.preventDefault();if(inFlight.current||limitReached)return;
  const form=event.currentTarget,control=form.elements.namedItem('screenshot');
  const file=control instanceof HTMLInputElement?control.files?.[0]:undefined;
  if(!(file instanceof File)||!file.size||file.size>TESTING_LIMITS.screenshotBytes||!['image/png','image/jpeg','image/webp'].includes(file.type)){setError('uploadInvalid');return;}
  inFlight.current=true;setError(null);
  try{await feedback.run(async()=>{
   const response=await fetch(`/system-testing/executions/${executionId}/attachments?runId=${encodeURIComponent(runId)}`,{method:'POST',redirect:'error',headers:{'content-type':file.type,'x-file-name':encodeURIComponent(file.name)},body:file});
   if(!response.ok)return {status:response.status>=500?'uncertain':'failed',message:response.status>=500?labels.uncertain:t('uploadFailed')};
   if(response.status!==201||response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new Error('Attachment receipt missing');
   const receiptText=await response.text();if(receiptText.length>4096)throw new Error('Attachment receipt invalid');
   const receipt:unknown=JSON.parse(receiptText);
   if(!receipt||typeof receipt!=='object'||!('id' in receipt)||typeof receipt.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.id))throw new Error('Attachment receipt invalid');
   // The attachment endpoint returns only after persistence; do not reset inputs before that response.
   form.reset();router.refresh();return {status:'success',value:undefined,message:labels.success};
  });}finally{inFlight.current=false;}
 }}>
  <label className="block"><span className="mb-1 block text-sm font-medium">{t('screenshot')}</span><input name="screenshot" type="file" className={inputCls} accept="image/png,image/jpeg,image/webp" required disabled={limitReached||feedback.pending}/></label>
  <p className="text-xs text-muted-foreground">{t('screenshotNote')}</p>{error&&<p role="alert" className="text-sm text-destructive">{t(error)}</p>}
  <ActionFeedback state={feedback.state}/><ActionButton aria-busy={feedback.pending} actionKind="uploading" className={btnPrimary} disabled={feedback.pending||limitReached}>{t('upload')}</ActionButton>
 </form>;
}
