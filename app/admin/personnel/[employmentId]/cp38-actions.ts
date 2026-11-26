'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { setCp38, updateCp38, terminateCp38, deleteCp38 } from '@/core/cp38';
import { cp38ErrorKey, cp38FormValues } from '@/lib/cp38-form';

// CP38 is per-employee master data managed from the employee detail page. Each action is admin-only
// (requireAdmin), routes through the event-logged service — which also checks that the caller administers payroll
// for the employee's company — and revalidates the detail page. A refusal comes back as `?cp38Error=<key>` (and the
// clashing record's identity for an overlap), which the CP38 card paints as a banner above the table.
// bc6b5490: there is no processed-period refusal any more (edits and deletes are always allowed; a processed run
// that is not closed is marked Reprocess Required instead), and Delete is new.
// Tab retention (feedback bd2f0bb2): the client tab shell injects a hidden `tab` field into the submitting
// form; thread it through so the post-save redirect returns to the originating tab, not Profile.
const back = (employmentId: string, qs: string, formData: FormData) => {
  const tab = String(formData.get('tab') ?? '').trim();
  redirect(`/admin/personnel/${employmentId}?${qs}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`);
};

/** The refusal as `cp38Error=<key>` plus the overlap's record identity, all encoded. */
const errorQs = (e: unknown): string => {
  const { key, args } = cp38ErrorKey(e);
  const qs = new URLSearchParams({ cp38Error: key ?? publicErrorMessage(e) });
  for (const [name, value] of Object.entries(args)) qs.set(`cp38${name[0].toUpperCase()}${name.slice(1)}`, value);
  return qs.toString();
};

export async function addCp38Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await setCp38(s, { employmentId, ...cp38FormValues(formData) });
  } catch (e) {
    back(employmentId, errorQs(e), formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

export async function editCp38Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await updateCp38(s, { id: String(formData.get('id')), ...cp38FormValues(formData) });
  } catch (e) {
    back(employmentId, errorQs(e), formData);
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
    back(employmentId, errorQs(e), formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Saved', formData);
}

/** 038c304b / bc6b5490 — Delete, behind the confirmation that names the record (ConfirmSubmit on the card). */
export async function deleteCp38Action(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = String(formData.get('employmentId'));
  try {
    await deleteCp38(s, { id: String(formData.get('id')) });
  } catch (e) {
    back(employmentId, errorQs(e), formData);
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, 'toast=Deleted', formData);
}
