'use server';
import { attendanceWorkflowErrorMessage } from '@/lib/attendance-workflow-error-message';

import { publicErrorMessage } from '@/lib/public-error';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { decideAttendanceCorrection, MissingAttendanceRejectReasonError } from '@/core/attendance';

export async function decideCorrectionAction(formData: FormData) {
  const s = await getSession();
  const back = formData.get('returnTo') === '/attendance/application-history/visible'
    ? '/attendance/application-history/visible' : '/attendance';
  let outcomeStatus: string = String(formData.get('decision'));
  try {
    const outcome = await decideAttendanceCorrection(s, {
      correctionId: String(formData.get('correctionId')),
      decision: String(formData.get('decision')) as 'approved' | 'rejected',
      rejectReason: String(formData.get('rejectReason') ?? ''),
      remarks: String(formData.get('remarks') ?? ''),
      expectedStageIndex: formData.get('workflowStage') ? Number(formData.get('workflowStage')) : undefined, expectedParticipantSlot: String(formData.get('workflowParticipant') ?? '') || undefined,
    });
    outcomeStatus = outcome.status;
  } catch (e) {
    redirect(`${back}?error=${encodeURIComponent(e instanceof MissingAttendanceRejectReasonError ? (await getTranslations('attendance'))('rejectRequired') : await attendanceWorkflowErrorMessage(e))}`);
  }
  for (const path of ['/attendance', '/attendance/application-history', '/attendance/application-history/visible', '/approvals', '/attendance/request-status']) revalidatePath(path);
  revalidatePath('/attendance/application-history/[id]', 'page');
  const t = await getTranslations('attendanceHistory');
  redirect(`${back}?toast=${encodeURIComponent(outcomeStatus === 'pending' ? t('stageRecorded') : t('finalOutcome', { status: t(`statuses.${outcomeStatus}`) }))}`);
}

