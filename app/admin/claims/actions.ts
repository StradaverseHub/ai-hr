'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveClaimFormField,
  archiveClaimItem,
  archiveClaimType,
  createClaimFormField,
  createClaimItem,
  createClaimType,
  deleteClaimType,
  moveClaimFormField,
  updateClaimFormField,
  updateClaimItem,
  updateClaimType,
} from '@/core/claims';

const BASE = '/admin/claims';
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
const numOrNull = (v: FormDataEntryValue | null): number | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : Number(s);
};
const strOrNull = (v: FormDataEntryValue | null): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

export async function createClaimTypeAction(formData: FormData) {
  const s = await getSession();
  try {
    await createClaimType(s, {
      code: String(formData.get('code') ?? ''),
      name: String(formData.get('name') ?? ''),
      description: strOrNull(formData.get('description')),
      defaultTaxable: formData.get('defaultTaxable') === 'on',
      requiresReceipt: formData.get('requiresReceipt') === 'on',
      maxReceiptAgeDays: numOrNull(formData.get('maxReceiptAgeDays')),
      isMileage: formData.get('isMileage') === 'on',
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim type created')}`);
}

export async function updateClaimTypeAction(formData: FormData) {
  const s = await getSession();
  try {
    await updateClaimType(s, {
      id: String(formData.get('id')),
      name: String(formData.get('name') ?? ''),
      description: strOrNull(formData.get('description')),
      defaultTaxable: formData.get('defaultTaxable') === 'on',
      requiresReceipt: formData.get('requiresReceipt') === 'on',
      maxReceiptAgeDays: numOrNull(formData.get('maxReceiptAgeDays')),
      // Always a boolean, never undefined: the panel's edit form always carries the checkbox, so an
      // UNTICK must arrive as false. Passing undefined would make "take the mileage flag off" a no-op.
      isMileage: formData.get('isMileage') === 'on',
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim type updated')}`);
}

export async function archiveClaimTypeAction(formData: FormData) {
  const s = await getSession();
  try {
    await archiveClaimType(s, String(formData.get('id')));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim type archived')}`);
}

export async function deleteClaimTypeAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteClaimType(s, String(formData.get('id')));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim type deleted')}`);
}

export async function createClaimItemAction(formData: FormData) {
  const s = await getSession();
  try {
    await createClaimItem(s, {
      claimTypeId: String(formData.get('claimTypeId')),
      code: String(formData.get('code') ?? ''),
      name: String(formData.get('name') ?? ''),
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim item created')}`);
}

export async function updateClaimItemAction(formData: FormData) {
  const s = await getSession();
  try {
    await updateClaimItem(s, { id: String(formData.get('id')), name: String(formData.get('name') ?? '') });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim item updated')}`);
}

export async function archiveClaimItemAction(formData: FormData) {
  const s = await getSession();
  try {
    await archiveClaimItem(s, String(formData.get('id')));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim item archived')}`);
}

// ───────────── Claim FORM designer (e7eb5d83 point 2) ─────────────
//
// These four moved here VERBATIM from app/admin/claims/forms/actions.ts when the Claim Forms tab was
// folded into the claim type's own panel. Only the redirect target changed: /admin/claims/forms no
// longer renders a designer, so sending an admin back there after a save would bounce them through a
// permanent redirect for nothing. There is deliberately ONE place to edit a claim form now — two
// screens editing the same rows is the duplication this item is contesting.

/** A dropdown's choices are typed one per line — the only multi-value input on this form. */
const optionsFrom = (v: FormDataEntryValue | null): string[] =>
  String(v ?? '')
    .split('\n')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

export async function createClaimFormFieldAction(formData: FormData) {
  const s = await getSession();
  try {
    await createClaimFormField(s, {
      claimTypeId: String(formData.get('claimTypeId') ?? ''),
      label: String(formData.get('label') ?? ''),
      kind: String(formData.get('kind') ?? 'text'),
      required: formData.get('required') === 'on',
      options: optionsFrom(formData.get('options')),
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim form field added')}`);
}

export async function updateClaimFormFieldAction(formData: FormData) {
  const s = await getSession();
  try {
    await updateClaimFormField(s, {
      id: String(formData.get('id') ?? ''),
      label: String(formData.get('label') ?? ''),
      kind: String(formData.get('kind') ?? 'text'),
      required: formData.get('required') === 'on',
      options: optionsFrom(formData.get('options')),
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim form field saved')}`);
}

/**
 * Remove a custom field. ARCHIVE, not delete — answers already stored on filed claims must survive.
 *
 * There is deliberately NO action here that can remove a built-in: amount, date, description and the
 * receipt are columns, not rows, so there is nothing for a forged POST to name. createClaimFormField
 * refuses their keys as well (BUILT_IN_FIELD_KEYS in core/claims.ts), so neither can they be re-created
 * as custom fields and then deleted. Moving the designer into the claim-type panel changed the screen,
 * not that guarantee — it never lived on the screen.
 */
export async function archiveClaimFormFieldAction(formData: FormData) {
  const s = await getSession();
  try {
    await archiveClaimFormField(s, String(formData.get('id') ?? ''));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim form field removed')}`);
}

export async function moveClaimFormFieldAction(formData: FormData) {
  const s = await getSession();
  const direction = String(formData.get('direction') ?? 'up') === 'down' ? 'down' : 'up';
  try {
    await moveClaimFormField(s, { id: String(formData.get('id') ?? ''), direction });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim form field moved')}`);
}
