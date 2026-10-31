'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setCp38, updateCp38, terminateCp38, Cp38PeriodProcessedError } from '@/core/cp38';

// CP38 is per-employee master data managed from the employee detail page. Each action is admin-only
// (requireAdmin), routes through the event-logged service, and revalidates the detail page. A
// Cp38PeriodProcessedError surfaces as a friendly `?cp38Error=processed` query the page maps to a hint.
// Tab retention (feedback bd2f0bb2): the client tab shell injects a hidden `tab` field into the submitting
// form; thread it through so the post-save redirect returns to the originating tab, not Profile.
const back = (employmentId: string, qs: string, formData: FormData) => {
  const tab = String(formData.get('tab') ?? '').trim();
  redirect(`/admin/personnel/${employmentId}?${qs}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`);
};

const errorKey = (e: unknown): string =>
  e instanceof Cp38PeriodProcessedError ? 'processed' : publicErrorMessage(e);

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
    back(employmentId, `cp38Error=${encodeURIComponent(errorKey(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
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
    back(employmentId, `cp38Error=${encodeURIComponent(errorKey(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

export async function terminateCp38Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await terminateCp38(s, { id: String(formData.get('id')) });
  } catch (e) {
    back(employmentId, `cp38Error=${encodeURIComponent(errorKey(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}
