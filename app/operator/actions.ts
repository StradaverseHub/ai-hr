'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { claimActivationUrl, createProvisionRequest, requestReissue } from '@/core/operator';

/**
 * Operator console server actions.
 *
 * Every one of them re-resolves the session and hands it to the service, which asserts the operator
 * tier and refuses on the demo deployment before RLS gets the final word. Nothing here trusts a value
 * that came from the form beyond the two strings a request is made of.
 */

export async function createCustomerAction(formData: FormData): Promise<void> {
  const s = await getSession();
  await createProvisionRequest(s, {
    customerName: String(formData.get('customerName') ?? ''),
    adminEmail: String(formData.get('adminEmail') ?? ''),
  });
  revalidatePath('/operator');
}

/**
 * Reveal the activation link. Returns null when it was already revealed — a normal outcome the UI
 * renders as "already revealed, use Reissue", NOT an error.
 *
 * THIS IS DESTRUCTIVE AND MUST ONLY EVER BE BOUND TO AN EXPLICIT BUTTON CLICK. The console refreshes
 * itself on a timer, so calling this during a render would burn the one-time link before any human saw
 * it. It deliberately does not revalidate the path either: the returned URL lives in client state for
 * the operator to copy, and a re-render would throw it away.
 */
export async function revealActivationUrlAction(requestId: string): Promise<string | null> {
  const s = await getSession();
  return claimActivationUrl(s, requestId);
}

export async function requestReissueAction(requestId: string): Promise<void> {
  const s = await getSession();
  await requestReissue(s, requestId);
  revalidatePath('/operator');
}
