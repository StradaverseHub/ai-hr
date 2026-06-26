'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { addClaimAttachment, cancelClaim, submitClaim } from '@/core/claims';

const BASE = '/claims';
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);

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
      claimItemId: String(formData.get('claimItemId') ?? '').trim() || null,
      amount: Number(formData.get('amount')),
      quantityKm: numOrNull(formData.get('quantityKm')),
      incurredOn: String(formData.get('incurredOn')),
      description: String(formData.get('description') ?? '').trim() || null,
      hasReceipt: hasFile,
    });
    if (hasFile) {
      const content = Buffer.from(await file.arrayBuffer());
      const mimeType = sniffMime(content);
      if (!mimeType) throw new Error('Only PDF, JPG, or PNG files are allowed');
      await addClaimAttachment(s, { claimRequestId: id, fileName: file.name, mimeType, content });
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
