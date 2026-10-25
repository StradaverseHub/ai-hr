'use client';
import {useActionState} from 'react';
import {useLocale} from 'next-intl';
import {Button} from '@/components/ui';
import type {NoticeAcknowledgementState} from '@/lib/notice-acknowledgement';

export function NoticeAcknowledgementForm({noticeId,employmentId,contentVersion,acknowledgedAt,action,labels}:{
 noticeId:string;employmentId:string;contentVersion:number;acknowledgedAt:string|null;
 action:(prior:NoticeAcknowledgementState,form:FormData)=>Promise<NoticeAcknowledgementState>;
 labels:{acknowledge:string;pending:string;acknowledgedOn:string;unavailable:string;changed:string;failed:string};
}){
 const [state,submit,pending]=useActionState(action,{}),locale=useLocale();
 const timestamp=acknowledgedAt??state.acknowledgedAt;
 return <div className="space-y-3 border-t border-border pt-4">
  {timestamp?<p role="status" className="text-sm"><time dateTime={timestamp}>{labels.acknowledgedOn.replace('{date}',new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(timestamp)))}</time></p>:<form action={submit} className="space-y-3">
   <input type="hidden" name="noticeId" value={noticeId}/><input type="hidden" name="employmentId" value={employmentId}/><input type="hidden" name="contentVersion" value={contentVersion}/>
   {state.error&&<p role="alert" className="max-w-prose text-sm text-destructive">{labels[state.error]}</p>}
   <Button type="submit" disabled={pending} className="min-h-11">{pending?labels.pending:labels.acknowledge}</Button>
  </form>}
 </div>;
}
