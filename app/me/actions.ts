'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { requestLeave } from '@/core/leave';
import { checkIn, checkOut } from '@/core/attendance';

/** Resolve the caller's own employment from the session — never from a form field. */
async function resolveMe() {
  const s = await getSession();
  const me = await myEmployment(s);
  if (!me) throw new Error('This account is not linked to an employee profile.');
  return { s, employmentId: me.employmentId };
}

function nowParts() {
  const d = new Date();
  return { date: d.toISOString().slice(0, 10), time: d.toTimeString().slice(0, 5) };
}

export async function myRequestLeave(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const leaveTypeId = String(formData.get('leaveTypeId'));
  const startDate = String(formData.get('startDate'));
  const endDate = String(formData.get('endDate'));
  try {
    await requestLeave(s, { employmentId, leaveTypeId, startDate, endDate });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Leave+requested');
}

export async function myCheckIn() {
  const { s, employmentId } = await resolveMe();
  const { date, time } = nowParts();
  try {
    await checkIn(s, { employmentId, date, time });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Checked+in');
}

export async function myCheckOut() {
  const { s, employmentId } = await resolveMe();
  const { date, time } = nowParts();
  try {
    await checkOut(s, { employmentId, date, time });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Checked+out');
}
