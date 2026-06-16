'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { markReimbursementsPaid } from '@/core/claims';

const BASE = '/admin/claims/reimbursements';

export async function markReimbursementsPaidAction(formData: FormData) {
  const s = await getSession();
  const claimIds = formData.getAll('claimId').map(String).filter(Boolean);
  const payoutRef = String(formData.get('payoutRef') ?? '').trim() || null;
  if (claimIds.length === 0) {
    redirect(`${BASE}?error=${encodeURIComponent('Select at least one reimbursement to mark as paid.')}`);
  }
  let paid = 0;
  try {
    ({ paid } = await markReimbursementsPaid(s, { claimIds, payoutRef }));
  } catch (e) {
    redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent(`Marked ${paid} reimbursement${paid === 1 ? '' : 's'} paid`)}`);
}
