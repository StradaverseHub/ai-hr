'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { checkIn, checkOut } from '@/core/attendance';

// Dev: "today" is fixed to the demo date.
const TODAY = '2026-06-05';

export async function checkInAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId'));
  try {
    await checkIn(s, { employmentId, date: TODAY, time: String(formData.get('time') || '09:00') });
  } catch (e) {
    redirect(`/attendance?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/attendance');
  redirect('/attendance?toast=Checked in');
}

export async function checkOutAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId'));
  try {
    await checkOut(s, { employmentId, date: TODAY, time: String(formData.get('time') || '18:00') });
  } catch (e) {
    redirect(`/attendance?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/attendance');
  redirect('/attendance?toast=Checked out');
}
