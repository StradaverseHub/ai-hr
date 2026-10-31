'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { unfreezeEncashment, adjustEncashment } from '@/core/leave-encashment';

// ADR-0069: HR's two override powers on a frozen leave-encashment snapshot (mirrors cp38-actions.ts).
// Both are admin-only (requireAdmin) and route through the event-logged service.
// Tab retention (feedback bd2f0bb2): the client tab shell injects a hidden `tab` field into the submitting
// form; thread it through so the post-save redirect returns to the originating tab, not Profile.
const back = (employmentId: string, qs: string, formData: FormData) => {
  const tab = String(formData.get('tab') ?? '').trim();
  redirect(`/admin/personnel/${employmentId}?${qs}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`);
};

export async function unfreezeEncashmentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await unfreezeEncashment(s, {
      snapshotId: String(formData.get('snapshotId')),
      reason: String(formData.get('reason') ?? ''),
    });
  } catch (e) {
    back(employmentId, `encashmentError=${encodeURIComponent(publicErrorMessage(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

export async function adjustEncashmentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await adjustEncashment(s, {
      snapshotId: String(formData.get('snapshotId')),
      overrideDays: Number(formData.get('overrideDays')) || 0,
      reason: String(formData.get('reason') ?? ''),
    });
  } catch (e) {
    back(employmentId, `encashmentError=${encodeURIComponent(publicErrorMessage(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}
