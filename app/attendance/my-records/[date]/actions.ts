'use server';
import { AttendanceLevelError, attendanceLevelProblemToken } from '@/lib/attendance-workflow-v3';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { scopedSession } from '@/lib/scope';
import { ownAttendanceRecordSubject } from '../subject';
import { CALENDAR_RETURN_FIELDS, calendarReturnParams } from '../../my-roster/attendance-links';
import {
  requestAttendanceCorrection,
  AttendanceCorrectionFutureDateError,
  AttendanceCorrectionPendingError,
  AttendancePayrollClosedError,
  AttendanceWorkflowError,
} from '@/packs/attendance/service';

export async function requestOwnAttendanceDayAction(formData: FormData) {
  const { s } = await scopedSession();
  const date = String(formData.get('date') ?? '');
  const query = new URLSearchParams();
  for (const key of ['from', 'to']) {
    const value = String(formData.get(key) ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) query.set(key, value);
  }
  const calendar = calendarReturnParams(Object.fromEntries(CALENDAR_RETURN_FIELDS.map(key => [key, String(formData.get(key) ?? '')])));
  for (const [key, value] of Object.entries(calendar)) query.set(key, value);
  const selectors=formData.getAll('employmentId');
  const selector=selectors.length===0?undefined:selectors.length===1&&typeof selectors[0]==='string'?selectors[0]:[];
  if(typeof selector==='string')query.set('employmentId',selector);
  if(formData.get('home')==='1')query.set('home','1');
  const back = `/attendance/my-records/${encodeURIComponent(date)}?${query.toString()}`;
  // Page-owned message keys must survive the global literal-message toast consumer.
  const fail = (key: string): never => redirect(`${back}&correctionError=${key}`);
  const me=await ownAttendanceRecordSubject(s,selector);
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
    if (error instanceof AttendanceLevelError) redirect(`${back}&workflowProblem=${encodeURIComponent(attendanceLevelProblemToken(error.problem))}`);
    if (error instanceof AttendanceCorrectionPendingError) fail('myDayPending');
    if (error instanceof AttendanceCorrectionFutureDateError) fail('myDayFuture');
    if (error instanceof AttendancePayrollClosedError) fail('clockDataPayrollClosed');
    if (error instanceof AttendanceWorkflowError && ['noMatch', 'tie', 'unresolved'].includes(error.code)) fail('myDayWorkflowUnavailable');
    fail('correctionRejected');
  }
  revalidatePath('/attendance/my-records');
  revalidatePath('/attendance/my-roster');
  revalidatePath(`/attendance/my-records/${date}`);
  revalidatePath('/attendance/requests');
  redirect(`${back}&corrected=1`);
}
