'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import {
  addQualification,
  updateQualification,
  archiveQualification,
  QualificationValidationError,
} from '@/core/qualifications';

// Personnel (Admin) — Qualification tab (feedback a949184a). Each action is admin-only (requireAdmin →
// RLS WITH CHECK is_admin()), routes through the event-logged service, and revalidates the detail page.
// The record is employment-keyed, so the page's employmentId doubles as the record key.
// Tab retention (feedback bd2f0bb2): the dialog forms carry a STATIC hidden `tab` field (they render in a
// portal outside the tab shell); thread it through so the post-save redirect returns to this tab.
const back = (employmentId: string, qs: string, formData: FormData) => {
  const tab = String(formData.get('tab') ?? '').trim();
  redirect(`/admin/personnel/${employmentId}?${qs}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`);
};

const errorMsg = (e: unknown): string =>
  e instanceof QualificationValidationError ? e.message : publicErrorMessage(e);

const str = (v: FormDataEntryValue | null): string | undefined => {
  const s = (v as string) ?? '';
  return s.trim() === '' ? undefined : s;
};

// Every field is always present on the (single-layout) qualification form, so edit semantics are simply
// present-but-blank ⇒ null (clear); no `__present` tri-state markers are needed here.
const editStr = (formData: FormData, key: string): string | null =>
  str(formData.get(key)) ?? null;

export async function addQualificationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await addQualification(s, {
      employmentId,
      qualification: String(formData.get('qualification') ?? '').trim(),
      description: str(formData.get('description')) ?? null,
      fromYm: str(formData.get('fromYm')) ?? null,
      toYm: str(formData.get('toYm')) ?? null,
      institute: str(formData.get('institute')) ?? null,
      major: str(formData.get('major')) ?? null,
      graduationDate: str(formData.get('graduationDate')) ?? null,
      result: str(formData.get('result')) ?? null,
      isHighest: formData.get('isHighest') != null,
    });
  } catch (e) {
    back(employmentId, `error=${encodeURIComponent(errorMsg(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

export async function editQualificationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await updateQualification(s, {
      id: String(formData.get('id')),
      qualification: str(formData.get('qualification')),
      description: editStr(formData, 'description'),
      fromYm: editStr(formData, 'fromYm'),
      toYm: editStr(formData, 'toYm'),
      institute: editStr(formData, 'institute'),
      major: editStr(formData, 'major'),
      graduationDate: editStr(formData, 'graduationDate'),
      result: editStr(formData, 'result'),
      isHighest: formData.get('isHighest') != null,
    });
  } catch (e) {
    back(employmentId, `error=${encodeURIComponent(errorMsg(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

export async function archiveQualificationAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await archiveQualification(s, { id: String(formData.get('id')) });
  } catch (e) {
    back(employmentId, `error=${encodeURIComponent(errorMsg(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}
