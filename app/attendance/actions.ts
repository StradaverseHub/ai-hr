'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { checkIn, checkOut } from '@/core/attendance';

const dateOf = (formData: FormData) => {
  const d = String(formData.get('date') || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
};

export async function checkInAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId'));
  const date = dateOf(formData);
  try {
    await checkIn(s, { employmentId, date, time: String(formData.get('time') || '09:00') });
  } catch (e) {
    redirect(`/attendance?date=${date}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/attendance');
  redirect(`/attendance?date=${date}&toast=Checked in`);
}

export async function checkOutAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId'));
  const date = dateOf(formData);
  try {
    await checkOut(s, { employmentId, date, time: String(formData.get('time') || '18:00') });
  } catch (e) {
    redirect(`/attendance?date=${date}&error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/attendance');
  redirect(`/attendance?date=${date}&toast=Checked out`);
}
