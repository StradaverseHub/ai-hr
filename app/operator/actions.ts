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
    country: String(formData.get('country') ?? 'MY'),
    // Carried through so the console's Retry can replay a recorded plan. The create form has no plan
    // picker yet (slice 5 adds the commercial record), so this is null on a first submission.
    plan: String(formData.get('plan') ?? '') || undefined,
    // getAll: the module picker is a checkbox group, so an unticked form sends nothing and a
    // multi-tick sends repeats of the same key. Retry re-posts the same key once per replayed module.
    // core/operator validates the codes — nothing here trusts them, matching this file's posture.
    modules: formData.getAll('modules').map(String).filter(Boolean),
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
