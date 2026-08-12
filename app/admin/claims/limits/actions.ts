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
  // e7eb5d83 rev 4 point 3c — Per block is all-four-or-none. The tick is the switch: unticked (or the
  // whole row Unlimited) sends all four as null, which is "no per-block rule" and is every row today.
  // blockStartOn deliberately passes through EMPTY as null rather than as today's date: null is what
  // makes setClaimPolicy inherit the anchor already on the rule instead of restarting the window.
  const blockOn = !unlimited && formData.get('blockEnabled') === 'on';
  const rawBlockStart = String(formData.get('blockStartOn') ?? '').trim();
  try {
    await setClaimPolicy(s, {
      claimTypeId: String(formData.get('claimTypeId')),
      gradeId,
      annualBudget: unlimited ? null : numOrNull(formData.get('annualBudget')),
      perClaimCap: unlimited ? null : numOrNull(formData.get('perClaimCap')),
      monthlyLimit: unlimited ? null : numOrNull(formData.get('monthlyLimit')),
      // e7eb5d83 point 3b — no lifetimeLimit read: the field left this screen. setClaimPolicy still
      // ACCEPTS it (the column, the scope and the enforcement branch are untouched), so re-adding the
      // input is the only change needed to bring it back.
      maxClaimsPerYear: unlimited ? null : intOrNull(formData.get('maxClaimsPerYear')),
      blockLength: blockOn ? intOrNull(formData.get('blockLength')) : null,
      blockUnit: blockOn ? String(formData.get('blockUnit') ?? 'year') : null,
      blockLimit: blockOn ? numOrNull(formData.get('blockLimit')) : null,
      blockStartOn: blockOn && rawBlockStart !== '' ? rawBlockStart : null,
      effectiveFrom: String(formData.get('effectiveFrom')),
      rateConfig: rateConfigFrom(formData),
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  // e7eb5d83 — the limits screen is now grade-first and its selection lives in ?gradeId=. Redirecting back
  // without it would bounce the admin to the company-wide view after every save, which reads as the save
  // having gone to the wrong grade.
  const back = gradeId ? `${BASE}?gradeId=${encodeURIComponent(gradeId)}` : BASE;
  redirect(`${back}${gradeId ? '&' : '?'}toast=${encodeURIComponent('Claim limit saved')}`);
}
