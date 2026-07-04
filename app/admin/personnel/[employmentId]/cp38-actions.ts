'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setCp38, updateCp38, terminateCp38, Cp38PeriodProcessedError } from '@/core/cp38';

// CP38 is per-employee master data managed from the employee detail page. Each action is admin-only
// (requireAdmin), routes through the event-logged service, and revalidates the detail page. A
// Cp38PeriodProcessedError surfaces as a friendly `?cp38Error=processed` query the page maps to a hint.
const back = (employmentId: string, qs: string) =>
  redirect(`/admin/personnel/${employmentId}?${qs}`);

const errorKey = (e: unknown): string =>
  e instanceof Cp38PeriodProcessedError ? 'processed' : (e as Error).message;

const str = (v: FormDataEntryValue | null): string | undefined => {
  const s = (v as string) ?? '';
  return s.trim() === '' ? undefined : s;
};

export async function addCp38Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setCp38(s, {
      employmentId,
      cp38Ref: String(formData.get('cp38Ref') ?? '').trim(),
      amount: Number(formData.get('amount')) || 0,
      validFrom: String(formData.get('validFrom') ?? ''),
      validTo: str(formData.get('validTo')) ?? null,
      remarks: str(formData.get('remarks')) ?? null,
    });
  } catch (e) {
    back(employmentId, `cp38Error=${encodeURIComponent(errorKey(e))}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved');
}

export async function editCp38Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await updateCp38(s, {
      id: String(formData.get('id')),
      cp38Ref: str(formData.get('cp38Ref')),
      amount: Number(formData.get('amount')) || 0,
      validFrom: str(formData.get('validFrom')),
      validTo: formData.get('validTo') !== null ? (str(formData.get('validTo')) ?? null) : undefined,
      remarks: formData.get('remarks') !== null ? (str(formData.get('remarks')) ?? null) : undefined,
    });
  } catch (e) {
    back(employmentId, `cp38Error=${encodeURIComponent(errorKey(e))}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved');
}

export async function terminateCp38Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await terminateCp38(s, { id: String(formData.get('id')) });
  } catch (e) {
    back(employmentId, `cp38Error=${encodeURIComponent(errorKey(e))}`);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved');
}
