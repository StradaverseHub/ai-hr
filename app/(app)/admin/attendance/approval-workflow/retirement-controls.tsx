'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {ConfirmSubmit} from '@/components/ui/confirm-submit';
import {retireAttendanceWorkflowAction,restoreAttendanceWorkflowAction} from './actions';
import {companyWorkflowHref} from './navigation';
export function WorkflowRetirementControls({lineageId,version,name,company,retired=false}:{lineageId:string;version:number;name:string;company:string;retired?:boolean}) {
 const t=useTranslations('attendanceWorkflow'),v4=useTranslations('attendanceWorkflow.v4'),router=useRouter(),[pending,start]=useTransition(),[error,setError]=useState('');
 return <div className="space-y-2"><form onSubmit={e=>{e.preventDefault();start(async()=>{setError('');try{const result=retired?await restoreAttendanceWorkflowAction(lineageId,version):await retireAttendanceWorkflowAction(lineageId,version);if(!result.ok){setError(result.error);return;}if('companyId' in result)router.push(`${companyWorkflowHref(result.companyId,result.applicationType)}&notice=deleted`);else router.push(`/admin/attendance/approval-workflow/${result.lineageId}`);router.refresh();}catch{setError(t('requestFailed'));}});}}>
 {retired?<Button type="submit" variant="secondary" disabled={pending}>{v4('restore')}</Button>:<ConfirmSubmit title={v4('deleteTitle',{name})} description={v4('deleteImpact',{company})} confirmLabel={v4('delete')} cancelLabel={t('cancel')} disabled={pending}>{v4('delete')}</ConfirmSubmit>}
 </form>{error&&<p role="alert" className="max-w-prose text-sm text-destructive">{error}</p>}</div>;
}
