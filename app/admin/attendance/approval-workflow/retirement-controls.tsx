'use client';
import {useState,useTransition} from 'react';
import {ActionFeedback,useActionFeedbackLabels,usePendingAction} from '@/components/action-feedback';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {ConfirmSubmit} from '@/components/ui/confirm-submit';
import {retireAttendanceWorkflowAction,restoreAttendanceWorkflowAction,archiveAttendanceWorkflowAction} from './actions';
import {companyWorkflowHref} from './navigation';
export function WorkflowRetirementControls({lineageId,version,name,company,retired=false,used=false}:{lineageId:string;version:number;name:string;company:string;retired?:boolean;used?:boolean}) {
 const t=useTranslations('attendanceWorkflow'),v4=useTranslations('attendanceWorkflow.v4'),router=useRouter(),[pending,start]=useTransition(),[error,setError]=useState('');
 const feedback=useActionFeedbackLabels();
 usePendingAction(pending,feedback.processing,true);
 return <div className="space-y-2"><ActionFeedback state={{status:pending?'processing':'idle',message:feedback.processing}}/><form onSubmit={e=>{e.preventDefault();start(async()=>{setError('');try{const result=retired?await restoreAttendanceWorkflowAction(lineageId,version):await (used?archiveAttendanceWorkflowAction:retireAttendanceWorkflowAction)(lineageId,version);if(!result.ok){setError(result.error);return;}if('companyId' in result)router.push(`${companyWorkflowHref(result.companyId,result.applicationType)}&notice=${used?'archived':'deleted'}`);else router.push(`/admin/attendance/approval-workflow/${result.lineageId}`);router.refresh();}catch{setError(t('requestFailed'));}});}}>
 {retired?<Button aria-busy={pending} type="submit" variant="secondary" disabled={pending}>{v4('restore')}</Button>:<ConfirmSubmit title={v4(used?'archiveTitle':'deleteTitle',{name})} description={v4(used?'archiveImpact':'unusedDeleteImpact',{company})} confirmLabel={v4(used?'archive':'delete')} cancelLabel={t('cancel')} disabled={pending}>{v4(used?'archive':'delete')}</ConfirmSubmit>}
 </form>{error&&<p role="alert" className="max-w-prose text-sm text-destructive">{error}</p>}</div>;
}
