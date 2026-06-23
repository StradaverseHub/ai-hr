'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { addLeaveAttachment, requestLeave } from '@/core/leave';
import { checkIn, checkOut, requestAttendanceCorrection } from '@/core/attendance';
import { requestProfileChange, updateOwnContact, type ProfileChangeProposed } from '@/core/profile';
import {
  createGoal,
  declinePeerFeedback,
  submitPeerFeedback,
  updateGoal,
  updateGoalProgress,
  type GoalStatus,
} from '@/core/performance';

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
  const file = formData.get('document');
  const hasFile = file instanceof File && file.size > 0;
  try {
    const { leaveRequestId } = await requestLeave(s, {
      employmentId,
      leaveTypeId,
      startDate,
      endDate,
      hasDocument: hasFile,
    });
    if (hasFile) {
      await addLeaveAttachment(s, {
        leaveRequestId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
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
  // #24: compliance-sensitive identity fields are requested here (approval-gated), not self-applied.
  const dateOfBirth = String(formData.get('dateOfBirth') ?? '').trim();
  const gender = String(formData.get('gender') ?? '').trim();
  const maritalStatus = String(formData.get('maritalStatus') ?? '').trim();
  if (dateOfBirth) proposed.dateOfBirth = dateOfBirth;
  if (gender) proposed.gender = gender;
  if (maritalStatus) proposed.maritalStatus = maritalStatus;
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

// ── Goals (ADR-0022) — the employee's own continuous goals ──

const strOrUndef = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s === '' ? undefined : s;
};

export async function myCreateGoal(formData: FormData) {
  const { s, employmentId } = await resolveMe();
  const title = String(formData.get('title') ?? '').trim();
  const weightRaw = strOrUndef(formData.get('weight'));
  try {
    await createGoal(s, {
      employmentId,
      title,
      description: strOrUndef(formData.get('description')),
      metric: strOrUndef(formData.get('metric')),
      target: strOrUndef(formData.get('target')),
      dueOn: strOrUndef(formData.get('dueOn')) ?? null,
      weight: weightRaw != null ? Number(weightRaw) : null,
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Goal+added');
}

export async function myUpdateGoalProgress(formData: FormData) {
  const s = await getSession();
  const goalId = String(formData.get('goalId'));
  try {
    await updateGoalProgress(s, {
      goalId,
      progress: Number(formData.get('progress')) || 0,
      status: String(formData.get('status')) as GoalStatus,
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Goal+updated');
}

export async function mySubmitPeerFeedback(formData: FormData) {
  const s = await getSession();
  try {
    await submitPeerFeedback(s, {
      requestId: String(formData.get('requestId')),
      strengths: strOrUndef(formData.get('strengths')),
      improvements: strOrUndef(formData.get('improvements')),
      named: formData.get('named') === 'on',
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Feedback+submitted');
}

export async function myDeclinePeerFeedback(formData: FormData) {
  const s = await getSession();
  try {
    await declinePeerFeedback(s, { requestId: String(formData.get('requestId')) });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Declined');
}

export async function myEditGoal(formData: FormData) {
  const s = await getSession();
  const goalId = String(formData.get('goalId'));
  try {
    await updateGoal(s, {
      goalId,
      title: strOrUndef(formData.get('title')),
      description: strOrUndef(formData.get('description')) ?? '',
    });
  } catch (e) {
    redirect(`/me?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/me');
  redirect('/me?toast=Goal+updated');
}
