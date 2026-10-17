'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TESTING_LIMITS } from '@/lib/system-testing/model';
import { btnPrimary,inputCls } from '@/components/ui';
export function TestingScreenshotUpload({ executionId,runId,limitReached=false }: {executionId:string;runId:string;limitReached?:boolean}) {
  const t=useTranslations('systemTestingWorkspace'),router=useRouter(),[pending,setPending]=useState(false),[error,setError]=useState<'uploadFailed'|'uploadInvalid'|null>(null);
  return <form className="space-y-3" onSubmit={async event=>{event.preventDefault();const form=event.currentTarget,file=new FormData(form).get('screenshot');if(!(file instanceof File)||!file.size||file.size>TESTING_LIMITS.screenshotBytes||!['image/png','image/jpeg','image/webp'].includes(file.type)){setError('uploadInvalid');return;}setPending(true);setError(null);try{const response=await fetch(`/system-testing/executions/${executionId}/attachments?runId=${encodeURIComponent(runId)}`,{method:'POST',headers:{'content-type':file.type,'x-file-name':encodeURIComponent(file.name)},body:file});if(!response.ok){setError('uploadFailed');return;}form.reset();router.refresh();}catch{setError('uploadFailed');}finally{setPending(false);}}}><label className="block"><span className="mb-1 block text-sm font-medium">{t('screenshot')}</span><input name="screenshot" type="file" className={inputCls} accept="image/png,image/jpeg,image/webp" required disabled={limitReached||pending}/></label><p className="text-xs text-muted-foreground">{t('screenshotNote')}</p>{error&&<p role="alert" className="text-sm text-destructive">{t(error)}</p>}<button className={btnPrimary} disabled={pending||limitReached}>{pending?t('saving'):t('upload')}</button></form>;
}
