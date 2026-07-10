'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import {
  addDependent,
  updateDependent,
  archiveDependent,
  DependentValidationError,
} from '@/core/dependents';

// Family / Dependents (phase 1) — per-person benefits/insurance register, managed from the employee detail
// page. Each action is admin-only (requireAdmin → RLS WITH CHECK is_admin()), routes through the
// event-logged service, and revalidates the detail page. The page is keyed by employmentId (for the redirect
// path) but the record is keyed by personId, passed through the hidden form field.
// Tab retention (feedback bd2f0bb2): the client tab shell injects a hidden `tab` field into the submitting
// form; thread it through so the post-save redirect returns to the originating tab, not Profile.
const back = (employmentId: string, qs: string, formData: FormData) => {
  const tab = String(formData.get('tab') ?? '').trim();
  redirect(`/admin/personnel/${employmentId}?${qs}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`);
};

const errorMsg = (e: unknown): string =>
  e instanceof DependentValidationError ? e.message : (e as Error).message;

const str = (v: FormDataEntryValue | null): string | undefined => {
  const s = (v as string) ?? '';
  return s.trim() === '' ? undefined : s;
};

export async function addDependentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await addDependent(s, {
      personId: String(formData.get('personId')),
      fullName: String(formData.get('fullName') ?? '').trim(),
      relationship: String(formData.get('relationship') ?? '').trim(),
      dateOfBirth: str(formData.get('dateOfBirth')) ?? null,
      gender: str(formData.get('gender')) ?? null,
      icOrPassport: str(formData.get('icOrPassport')) ?? null,
      isBeneficiary: formData.get('isBeneficiary') != null,
      phone: str(formData.get('phone')) ?? null,
      remarks: str(formData.get('remarks')) ?? null,
    });
  } catch (e) {
    back(employmentId, `error=${encodeURIComponent(errorMsg(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

export async function editDependentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await updateDependent(s, {
      id: String(formData.get('id')),
      fullName: str(formData.get('fullName')),
      relationship: str(formData.get('relationship')),
      dateOfBirth: formData.get('dateOfBirth') !== null ? (str(formData.get('dateOfBirth')) ?? null) : undefined,
      gender: formData.get('gender') !== null ? (str(formData.get('gender')) ?? null) : undefined,
      icOrPassport:
        formData.get('icOrPassport') !== null ? (str(formData.get('icOrPassport')) ?? null) : undefined,
      isBeneficiary: formData.get('isBeneficiary') != null,
      phone: formData.get('phone') !== null ? (str(formData.get('phone')) ?? null) : undefined,
      remarks: formData.get('remarks') !== null ? (str(formData.get('remarks')) ?? null) : undefined,
    });
  } catch (e) {
    back(employmentId, `error=${encodeURIComponent(errorMsg(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

export async function archiveDependentAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await archiveDependent(s, { id: String(formData.get('id')) });
  } catch (e) {
    back(employmentId, `error=${encodeURIComponent(errorMsg(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}
