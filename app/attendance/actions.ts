'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { decideAttendanceCorrection, MissingAttendanceRejectReasonError } from '@/core/attendance';

export async function decideCorrectionAction(formData: FormData) {
  const s = await getSession();
  const back = '/attendance';
  let outcomeStatus: string = String(formData.get('decision'));
  try {
    const outcome = await decideAttendanceCorrection(s, {
      correctionId: String(formData.get('correctionId')),
      decision: String(formData.get('decision')) as 'approved' | 'rejected',
      rejectReason: String(formData.get('rejectReason') ?? ''),
      remarks: String(formData.get('remarks') ?? ''),
      expectedStageIndex: formData.get('workflowStage') ? Number(formData.get('workflowStage')) : undefined,
    });
    outcomeStatus = outcome.status;
  } catch (e) {
    redirect(`${back}?error=${encodeURIComponent(e instanceof MissingAttendanceRejectReasonError ? (await getTranslations('attendance'))('rejectRequired') : publicErrorMessage(e))}`);
  }
  revalidatePath(back);
  redirect(`${back}?toast=${encodeURIComponent(outcomeStatus === 'pending' ? (await getTranslations('attendanceHistory'))('stageRecorded') : 'Correction ' + String(formData.get('decision')))}`);
}

