'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { requestLeave } from '@/core/leave';
import { checkIn, checkOut, requestAttendanceCorrection } from '@/core/attendance';
import { requestProfileChange, updateOwnContact, type ProfileChangeProposed } from '@/core/profile';

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

export async function myRequestCorrection(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const date = String(formData.get('date'));
  const checkInTime = String(formData.get('checkIn'));
  const checkOutTime = String(formData.get('checkOut') || '');
  const reason = String(formData.get('reason') || '').trim();
  try {
    await requestAttendanceCorrection(s, {
      employmentId,
      date,
      checkIn: checkInTime,
      checkOut: checkOutTime || null,
      reason: reason || undefined,
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Correction+requested');
}

export async function myUpdateContact(formData: FormData) {
  const { s } = await resolveMe();
  try {
    await updateOwnContact(s, {
      phone: String(formData.get('phone') ?? ''),
      address: String(formData.get('address') ?? ''),
      dateOfBirth: String(formData.get('dateOfBirth') ?? ''),
      emergencyContactName: String(formData.get('emergencyContactName') ?? ''),
      emergencyContactPhone: String(formData.get('emergencyContactPhone') ?? ''),
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Profile+updated');
}

export async function myRequestProfileChange(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  // Only carry the fields the employee actually filled — the rest are left unchanged.
  const proposed: ProfileChangeProposed = {};
  const bankName = String(formData.get('bankName') ?? '').trim();
  const bankAccountNo = String(formData.get('bankAccountNo') ?? '').trim();
  const taxCategory = String(formData.get('taxCategory') ?? '').trim();
  const numChildren = String(formData.get('numChildren') ?? '').trim();
  if (bankName) proposed.bankName = bankName;
  if (bankAccountNo) proposed.bankAccountNo = bankAccountNo;
  if (taxCategory) proposed.taxCategory = Number(taxCategory);
  if (numChildren) proposed.numChildren = Number(numChildren);
  try {
    await requestProfileChange(s, { employmentId, proposed });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Change+requested+for+approval');
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
