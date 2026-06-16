'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { archiveClaimType, createClaimType, setClaimPolicy, updateClaimType } from '@/core/claims';

const BASE = '/admin/claims';
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
const numOrNull = (v: FormDataEntryValue | null): number | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : Number(s);
};

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
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Budget updated')}`);
}
