'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import {
  addEmergencyContact,
  updateEmergencyContact,
  archiveEmergencyContact,
  EmergencyContactValidationError,
} from '@/core/emergency-contacts';

// Personnel (Admin) — Emergency Contact register (feedback 23ad620e). Each action routes through the
// event-logged service and revalidates the detail page. The record is PERSON-keyed (an emergency contact
// follows the person, not one employment), so the forms carry both ids: personId for the write and
// employmentId for the redirect back to the profile the admin came from.
// Tab retention (feedback bd2f0bb2): the dialog forms render in a portal outside the tab shell, so they
// carry a STATIC hidden `tab` field; thread it through so the post-save redirect returns to this tab.
const back = (employmentId: string, qs: string, formData: FormData) => {
  const tab = String(formData.get('tab') ?? '').trim();
  redirect(`/admin/personnel/${employmentId}?${qs}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`);
};

const errorMsg = (e: unknown): string =>
  e instanceof EmergencyContactValidationError ? e.message : (e as Error).message;

// Every field is always present on the (single-layout) contact form, so present-but-blank ⇒ null (clear).
const str = (formData: FormData, key: string): string | null => {
  const s = String(formData.get(key) ?? '').trim();
  return s === '' ? null : s;
};

export async function addEmergencyContactAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await addEmergencyContact(s, {
      personId: String(formData.get('personId')),
      fullName: String(formData.get('fullName') ?? '').trim(),
      relationship: str(formData, 'relationship'),
      mobilePhone: str(formData, 'mobilePhone'),
      homePhone: str(formData, 'homePhone'),
      address: str(formData, 'address'),
      remarks: str(formData, 'remarks'),
      priority: str(formData, 'priority'),
    });
  } catch (e) {
    back(employmentId, `error=${encodeURIComponent(errorMsg(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

export async function editEmergencyContactAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await updateEmergencyContact(s, {
      id: String(formData.get('id')),
      fullName: String(formData.get('fullName') ?? '').trim(),
      relationship: str(formData, 'relationship'),
      mobilePhone: str(formData, 'mobilePhone'),
      homePhone: str(formData, 'homePhone'),
      address: str(formData, 'address'),
      remarks: str(formData, 'remarks'),
      priority: str(formData, 'priority'),
    });
  } catch (e) {
    back(employmentId, `error=${encodeURIComponent(errorMsg(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

export async function deleteEmergencyContactAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await archiveEmergencyContact(s, { id: String(formData.get('id')) });
  } catch (e) {
    back(employmentId, `error=${encodeURIComponent(errorMsg(e))}`, formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}
