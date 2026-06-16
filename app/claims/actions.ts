'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { addClaimAttachment, cancelClaim, submitClaim } from '@/core/claims';

const BASE = '/claims';
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);

export async function submitClaimAction(formData: FormData) {
  const s = await getSession();
  try {
    const me = await myEmployment(s);
    if (!me) throw new Error('No active employment is linked to your account.');
    const file = formData.get('receipt');
    const hasFile = file instanceof File && file.size > 0;
    const { id } = await submitClaim(s, {
      employmentId: me.employmentId,
      claimTypeId: String(formData.get('claimTypeId')),
      amount: Number(formData.get('amount')),
      incurredOn: String(formData.get('incurredOn')),
      description: String(formData.get('description') ?? '').trim() || null,
      hasReceipt: hasFile,
    });
    if (hasFile) {
      await addClaimAttachment(s, {
        claimRequestId: id,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim submitted')}`);
}

export async function cancelClaimAction(formData: FormData) {
  const s = await getSession();
  try {
    await cancelClaim(s, String(formData.get('id')));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Claim cancelled')}`);
}
