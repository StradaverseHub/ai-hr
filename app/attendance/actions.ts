'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { requireAdmin } from '@/lib/authz';
import { checkIn, checkOut, decideAttendanceCorrection, MissingAttendanceRejectReasonError } from '@/core/attendance';

import { todayInKualaLumpur } from '@/lib/hr-date';

const dateOf = (formData: FormData) => {
  const d = String(formData.get('date') || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayInKualaLumpur();
};

// Daily tab (314ea061) now hosts the per-employee day table, so check-in/out return there.
const DAILY = '/attendance/daily';

export async function checkInAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const date = dateOf(formData);
  try {
    await checkIn(s, { employmentId, date, time: String(formData.get('time') || '09:00') });
  } catch (e) {
    redirect(`${DAILY}?date=${date}&error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(DAILY);
  redirect(`${DAILY}?date=${date}&toast=Checked in`);
}

export async function decideCorrectionAction(formData: FormData) {
  const s = await getSession();
  const back = '/attendance';
  try {
    await decideAttendanceCorrection(s, {
      correctionId: String(formData.get('correctionId')),
      decision: String(formData.get('decision')) as 'approved' | 'rejected',
      rejectReason: String(formData.get('rejectReason') ?? ''),
    });
  } catch (e) {
    redirect(`${back}?error=${encodeURIComponent(e instanceof MissingAttendanceRejectReasonError ? (await getTranslations('attendance'))('rejectRequired') : publicErrorMessage(e))}`);
  }
  revalidatePath(back);
  redirect(`${back}?toast=${encodeURIComponent('Correction ' + String(formData.get('decision')))}`);
}

export async function checkOutAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  const date = dateOf(formData);
  try {
    await checkOut(s, { employmentId, date, time: String(formData.get('time') || '18:00') });
  } catch (e) {
    redirect(`${DAILY}?date=${date}&error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(DAILY);
  redirect(`${DAILY}?date=${date}&toast=Checked out`);
}
