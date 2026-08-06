'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveClaimFormField,
  createClaimFormField,
  moveClaimFormField,
  updateClaimFormField,
} from '@/core/claims';

const BASE = '/admin/claims/forms';

/** Keep the designer on the claim type the admin was editing after every action. */
const backTo = (claimTypeId: string, extra?: string): string =>
  `${BASE}?claimTypeId=${encodeURIComponent(claimTypeId)}${extra ? `&${extra}` : ''}`;

/** A dropdown's choices are typed one per line — the only multi-value input on this form. */
const optionsFrom = (v: FormDataEntryValue | null): string[] =>
  String(v ?? '')
    .split('\n')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

export async function createClaimFormFieldAction(formData: FormData) {
  const s = await getSession();
  const claimTypeId = String(formData.get('claimTypeId') ?? '');
  try {
    await createClaimFormField(s, {
      claimTypeId,
      label: String(formData.get('label') ?? ''),
      kind: String(formData.get('kind') ?? 'text'),
      required: formData.get('required') === 'on',
      options: optionsFrom(formData.get('options')),
    });
  } catch (e) {
    redirect(backTo(claimTypeId, `error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(BASE);
  redirect(backTo(claimTypeId));
}

export async function updateClaimFormFieldAction(formData: FormData) {
  const s = await getSession();
  const claimTypeId = String(formData.get('claimTypeId') ?? '');
  try {
    await updateClaimFormField(s, {
      id: String(formData.get('id') ?? ''),
      label: String(formData.get('label') ?? ''),
      kind: String(formData.get('kind') ?? 'text'),
      required: formData.get('required') === 'on',
      options: optionsFrom(formData.get('options')),
    });
  } catch (e) {
    redirect(backTo(claimTypeId, `error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(BASE);
  redirect(backTo(claimTypeId));
}

/**
 * Remove a custom field. ARCHIVE, not delete — answers already stored on filed claims must survive.
 *
 * There is deliberately NO action here that can remove a built-in: amount, date, description and the
 * receipt are columns, not rows, so there is nothing for a forged POST to name. createClaimFormField
 * refuses their keys as well, so neither can they be re-created as custom fields and then deleted.
 */
export async function archiveClaimFormFieldAction(formData: FormData) {
  const s = await getSession();
  const claimTypeId = String(formData.get('claimTypeId') ?? '');
  try {
    await archiveClaimFormField(s, String(formData.get('id') ?? ''));
  } catch (e) {
    redirect(backTo(claimTypeId, `error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(BASE);
  redirect(backTo(claimTypeId));
}

export async function moveClaimFormFieldAction(formData: FormData) {
  const s = await getSession();
  const claimTypeId = String(formData.get('claimTypeId') ?? '');
  const direction = String(formData.get('direction') ?? 'up') === 'down' ? 'down' : 'up';
  try {
    await moveClaimFormField(s, { id: String(formData.get('id') ?? ''), direction });
  } catch (e) {
    redirect(backTo(claimTypeId, `error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(BASE);
  redirect(backTo(claimTypeId));
}
