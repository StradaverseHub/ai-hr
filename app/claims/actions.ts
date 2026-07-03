'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { cancelClaim, submitClaimWithAttachment } from '@/core/claims';

const BASE = '/claims';
const errorUrl = (e: unknown) => `${BASE}?error=${encodeURIComponent((e as Error).message)}`;

/**
 * Derive a TRUSTWORTHY mime type from the file's leading bytes (fail-closed: unknown signature → null).
 * This replaces the spoofable client `file.type` (and its blank-type false-reject), so the service-layer
 * MIME allowlist is checked against what the file actually is, not what the browser claimed.
 */
function sniffMime(bytes: Buffer): string | null {
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

const numOrNull = (v: FormDataEntryValue | null): number | null => {
  const str = String(v ?? '').trim();
  return str === '' ? null : Number(str);
};

export type SubmitClaimState = { error: string | null };

/**
 * useActionState-driven: on FAILURE we return { error } instead of redirecting, so the form is never
 * unmounted/navigated away from and every field the user typed (including the file input's selection)
 * survives exactly as-is — the user just fixes the one field the error names and resubmits. On SUCCESS
 * we still redirect (a fresh claims list + an empty form is the correct outcome there). All DB work
 * happens in ONE service tx (submitClaimWithAttachment) so a receipt failure rolls the claim back too:
 * the user's error and the DB now agree — no committed-claim-behind-an-error (ADR-0021 §2 submit fix).
 */
export async function submitClaimAction(_prevState: SubmitClaimState, formData: FormData): Promise<SubmitClaimState> {
  const s = await getSession();
  try {
    const me = await myEmployment(s);
    // myEmployment is null when the account has no active employment; give a clear, actionable message
    // (the page also renders its own no-employment card, but the action guards the POST path too).
    if (!me) throw new Error('No active employment is linked to your account.');
    const file = formData.get('receipt');
    const hasFile = file instanceof File && file.size > 0;
    let attachment: { fileName: string; mimeType: string; content: Buffer } | null = null;
    if (hasFile) {
      const content = Buffer.from(await file.arrayBuffer());
      const mimeType = sniffMime(content);
      if (!mimeType) throw new Error('Only PDF, JPG, or PNG files are allowed');
      attachment = { fileName: file.name, mimeType, content };
    }
    await submitClaimWithAttachment(
      s,
      {
        employmentId: me.employmentId,
        claimTypeId: String(formData.get('claimTypeId')),
        claimItemId: String(formData.get('claimItemId') ?? '').trim() || null,
        amount: Number(formData.get('amount')),
        quantityKm: numOrNull(formData.get('quantityKm')),
        incurredOn: String(formData.get('incurredOn')),
        description: String(formData.get('description') ?? '').trim() || null,
        hasReceipt: hasFile,
      },
      attachment,
    );
    revalidatePath(BASE);
  } catch (e) {
    return { error: (e as Error).message };
  }
  redirect(`${BASE}?toast=${encodeURIComponent('Claim submitted')}`);
}

export async function cancelClaimAction(formData: FormData) {
  const s = await getSession();
  let redirectTo: string;
  try {
    await cancelClaim(s, String(formData.get('id')));
    revalidatePath(BASE);
    redirectTo = `${BASE}?toast=${encodeURIComponent('Claim cancelled')}`;
  } catch (e) {
    redirectTo = errorUrl(e);
  }
  redirect(redirectTo);
}
