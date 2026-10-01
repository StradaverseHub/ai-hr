'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { scopedSession } from '@/lib/scope';
import { myEmployment } from '@/core/read';
import {
  requestAttendanceCorrection,
  AttendanceCorrectionFutureDateError,
  AttendanceCorrectionPendingError,
} from '@/packs/attendance/service';

export async function requestOwnAttendanceDayAction(formData: FormData) {
  const { s } = await scopedSession();
  const me = await myEmployment(s);
  const date = String(formData.get('date') ?? '');
  const query = new URLSearchParams();
  for (const key of ['from', 'to']) {
    const value = String(formData.get(key) ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) query.set(key, value);
  }
  const back = `/attendance/my-records/${encodeURIComponent(date)}?${query.toString()}`;
  const fail = (key: string): never => redirect(`${back}&error=${key}`);
  if (!me) fail('correctionForbidden');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail('correctionBadDate');
  const checkIn = String(formData.get('checkIn') ?? '').trim();
  const checkOut = String(formData.get('checkOut') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!reason) fail('correctionReasonRequired');
  if (!checkIn && !checkOut) fail('correctionNothingToChange');
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if ((checkIn && !time.test(checkIn)) || (checkOut && (!time.test(checkOut) || !checkIn || checkOut <= checkIn))) fail('myDayBadTimes');
  try {
    await requestAttendanceCorrection(s, {
      employmentId: me!.employmentId,
      date,
      checkIn: checkIn || null,
      checkOut: checkOut || null,
      reason,
    });
  } catch (error) {
    if (error instanceof AttendanceCorrectionPendingError) fail('myDayPending');
    if (error instanceof AttendanceCorrectionFutureDateError) fail('myDayFuture');
    fail('correctionRejected');
  }
  revalidatePath('/attendance/my-records');
  revalidatePath(`/attendance/my-records/${date}`);
  revalidatePath('/attendance/requests');
  redirect(`${back}&corrected=1`);
}
