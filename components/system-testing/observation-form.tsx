'use client';
import { useActionState,useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveTestingObservationAction } from '@/app/admin/system-testing/workspace-actions';
import { INITIAL_TESTING_ACTION_STATE } from '@/lib/system-testing/action-model';
import { EXECUTION_STATUSES,type ExecutionStatus } from '@/lib/system-testing/model';
import { btnPrimary,inputCls } from '@/components/ui';
export function TestingObservationForm({ executionId,assignmentId,versionId,revision,current }: { executionId:string;assignmentId:string;versionId:string;revision:number;current:{status:ExecutionStatus;actualResult:string;comments:string;defectNotes:string;improvementNotes:string} }) {
  const t=useTranslations('systemTestingWorkspace'),[state,submit,pending]=useActionState(saveTestingObservationAction,INITIAL_TESTING_ACTION_STATE);
  const [openedRevision]=useState(revision);
  const expectedRevision=state.savedObservation?.executionId===executionId?state.savedObservation.revision:openedRevision;
  return <form action={submit} className="space-y-4"><input type="hidden" name="executionId" value={executionId}/><input type="hidden" name="assignmentId" value={assignmentId}/><input type="hidden" name="versionId" value={versionId}/><input type="hidden" name="revision" value={expectedRevision}/><label className="block"><span className="mb-1 block text-sm font-medium">{t('status')}</span><select name="status" className={inputCls} defaultValue={current.status}>{EXECUTION_STATUSES.map(status=><option key={status} value={status}>{t(`statuses.${status}`)}</option>)}</select></label>{(['actualResult','comments','defectNotes','improvementNotes'] as const).map(key=><label key={key} className="block"><span className="mb-1 block text-sm font-medium">{t(key)}</span><textarea name={key} className={`${inputCls} h-auto min-h-20 py-2`} defaultValue={current[key]} maxLength={16000} rows={3}/></label>)}{state.error&&<p role="alert" className="break-words text-sm text-destructive">{t(`errors.${state.error}`)}</p>}<button className={btnPrimary} disabled={pending}>{pending?t('saving'):t('saveObservation')}</button><p className="text-sm text-muted-foreground">{t('observationNote')}</p></form>;
}
