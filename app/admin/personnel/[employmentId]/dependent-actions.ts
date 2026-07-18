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

// A field the edit form only PRESENTS for some relationship sections. When the input isn't in the form
// (get === null) we pass `undefined` (leave unchanged); when present-but-blank we pass null (clear it).
const editStr = (formData: FormData, key: string): string | null | undefined =>
  formData.get(key) !== null ? (str(formData.get(key)) ?? null) : undefined;

// A tri-state boolean checkbox on the edit form: absent from the form → undefined (unchanged); present
// (rendered) → true/false. `${key}__present` is a hidden marker the form emits so an unticked box (which
// posts nothing) is still distinguishable from "field not on this section's form".
const editBool = (formData: FormData, key: string): boolean | undefined =>
  formData.get(`${key}__present`) !== null ? formData.get(key) != null : undefined;

// Item 6c635212 — a numeric select value. `numOrNull` (add form): blank ⇒ null, else Number. `editNum` (edit
// form, present-only semantics): field absent ⇒ undefined (unchanged); present-but-blank ⇒ null; else Number.
const numOrNull = (v: FormDataEntryValue | null): number | null => {
  const s = str(v);
  return s === undefined ? null : Number(s);
};
const editNum = (formData: FormData, key: string): number | null | undefined =>
  formData.get(key) !== null ? numOrNull(formData.get(key)) : undefined;

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
      // 4535b733 — enhancement fields.
      passportNumber: str(formData.get('passportNumber')) ?? null,
      residentialAddress: str(formData.get('residentialAddress')) ?? null,
      isDeceased: formData.get('isDeceased') != null,
      deceasedOn: str(formData.get('deceasedOn')) ?? null,
      occupation: str(formData.get('occupation')) ?? null,
      marriageDate: str(formData.get('marriageDate')) ?? null,
      marriageStatus: str(formData.get('marriageStatus')) ?? null,
      spouseWorking:
        formData.get('spouseWorking__present') !== null ? formData.get('spouseWorking') != null : null,
      companyName: str(formData.get('companyName')) ?? null,
      employerAddress: str(formData.get('employerAddress')) ?? null,
      isStudent: formData.get('isStudent__present') !== null ? formData.get('isStudent') != null : null,
      schoolName: str(formData.get('schoolName')) ?? null,
      // Item 6c635212 — Malaysia Income Tax child-relief config.
      childReliefCategory: str(formData.get('childReliefCategory')) ?? null,
      childTaxRelief:
        formData.get('childTaxRelief__present') !== null ? formData.get('childTaxRelief') != null : null,
      childReliefPercentage: numOrNull(formData.get('childReliefPercentage')),
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
      dateOfBirth: editStr(formData, 'dateOfBirth'),
      gender: editStr(formData, 'gender'),
      icOrPassport: editStr(formData, 'icOrPassport'),
      isBeneficiary: formData.get('isBeneficiary') != null,
      phone: editStr(formData, 'phone'),
      remarks: editStr(formData, 'remarks'),
      // 4535b733 — enhancement fields.
      passportNumber: editStr(formData, 'passportNumber'),
      residentialAddress: editStr(formData, 'residentialAddress'),
      isDeceased: editBool(formData, 'isDeceased'),
      deceasedOn: editStr(formData, 'deceasedOn'),
      occupation: editStr(formData, 'occupation'),
      marriageDate: editStr(formData, 'marriageDate'),
      marriageStatus: editStr(formData, 'marriageStatus'),
      spouseWorking: editBool(formData, 'spouseWorking'),
      companyName: editStr(formData, 'companyName'),
      employerAddress: editStr(formData, 'employerAddress'),
      isStudent: editBool(formData, 'isStudent'),
      schoolName: editStr(formData, 'schoolName'),
      // Item 6c635212 — Malaysia Income Tax child-relief config.
      childReliefCategory: editStr(formData, 'childReliefCategory'),
      childTaxRelief: editBool(formData, 'childTaxRelief'),
      childReliefPercentage: editNum(formData, 'childReliefPercentage'),
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
