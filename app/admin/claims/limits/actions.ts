'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { setClaimPolicy, type ClaimRateConfig } from '@/core/claims';

const BASE = '/admin/claims/limits';
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
const numOrNull = (v: FormDataEntryValue | null): number | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : Number(s);
};
const intOrNull = (v: FormDataEntryValue | null): number | null => {
  const n = numOrNull(v);
  return n == null ? null : Math.trunc(n);
};

/** Build the rate-config union from the form's `rateKind` radio + its conditional input. */
function rateConfigFrom(formData: FormData): ClaimRateConfig {
  const kind = String(formData.get('rateKind') ?? 'receipt');
  if (kind === 'mileage_flat') return { kind: 'mileage_flat', ratePerKm: Number(formData.get('ratePerKm') ?? 0) };
  if (kind === 'fixed_allowance') return { kind: 'fixed_allowance', amount: Number(formData.get('fixedAmount') ?? 0) };
  return { kind: 'receipt' };
}

export async function setClaimPolicyAction(formData: FormData) {
  const s = await getSession();
  // Unlimited toggle ⇒ every amount/count limit is NULL (an all-null row IS "unlimited").
  const unlimited = formData.get('unlimited') === 'on';
  const gradeId = String(formData.get('gradeId') ?? '').trim() || null;
  try {
    await setClaimPolicy(s, {
      claimTypeId: String(formData.get('claimTypeId')),
      gradeId,
      annualBudget: unlimited ? null : numOrNull(formData.get('annualBudget')),
      perClaimCap: unlimited ? null : numOrNull(formData.get('perClaimCap')),
      monthlyLimit: unlimited ? null : numOrNull(formData.get('monthlyLimit')),
      lifetimeLimit: unlimited ? null : numOrNull(formData.get('lifetimeLimit')),
      maxClaimsPerYear: unlimited ? null : intOrNull(formData.get('maxClaimsPerYear')),
      effectiveFrom: String(formData.get('effectiveFrom')),
      rateConfig: rateConfigFrom(formData),
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim limit saved')}`);
}
