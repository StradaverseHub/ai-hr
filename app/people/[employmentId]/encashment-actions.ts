'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { unfreezeEncashment, adjustEncashment } from '@/core/leave-encashment';

// ADR-0069: HR's two override powers on a frozen leave-encashment snapshot (mirrors cp38-actions.ts).
// Both are admin-only (requireAdmin) and route through the event-logged service.
const back = (employmentId: string, qs: string) => redirect(`/people/${employmentId}?${qs}`);

export async function unfreezeEncashmentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await unfreezeEncashment(s, {
      snapshotId: String(formData.get('snapshotId')),
      reason: String(formData.get('reason') ?? ''),
    });
  } catch (e) {
    back(employmentId, `encashmentError=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  back(employmentId, 'toast=Saved');
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
    back(employmentId, `encashmentError=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/people/${employmentId}`);
  back(employmentId, 'toast=Saved');
}
