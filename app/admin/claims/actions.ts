'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveClaimItem,
  archiveClaimType,
  createClaimItem,
  createClaimType,
  setClaimPolicy,
  updateClaimItem,
  updateClaimType,
  type ClaimRateConfig,
} from '@/core/claims';

const BASE = '/admin/claims';
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
const numOrNull = (v: FormDataEntryValue | null): number | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : Number(s);
};

/** Build the rate-config union from the form's `rateKind` radio + its conditional input. */
function rateConfigFrom(formData: FormData): ClaimRateConfig {
  const kind = String(formData.get('rateKind') ?? 'receipt');
  if (kind === 'mileage_flat') return { kind: 'mileage_flat', ratePerKm: Number(formData.get('ratePerKm') ?? 0) };
  if (kind === 'fixed_allowance') return { kind: 'fixed_allowance', amount: Number(formData.get('fixedAmount') ?? 0) };
  return { kind: 'receipt' };
}

export async function createClaimTypeAction(formData: FormData) {
  const s = await getSession();
  try {
    await createClaimType(s, {
      code: String(formData.get('code') ?? ''),
      name: String(formData.get('name') ?? ''),
      defaultTaxable: formData.get('defaultTaxable') === 'on',
      requiresReceipt: formData.get('requiresReceipt') === 'on',
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
      defaultTaxable: formData.get('defaultTaxable') === 'on',
      requiresReceipt: formData.get('requiresReceipt') === 'on',
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

export async function setClaimPolicyAction(formData: FormData) {
  const s = await getSession();
  try {
    await setClaimPolicy(s, {
      claimTypeId: String(formData.get('claimTypeId')),
      annualBudget: numOrNull(formData.get('annualBudget')),
      perClaimCap: numOrNull(formData.get('perClaimCap')),
      effectiveFrom: String(formData.get('effectiveFrom')),
      rateConfig: rateConfigFrom(formData),
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Budget updated')}`);
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
