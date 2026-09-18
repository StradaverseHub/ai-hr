'use server';

/**
 * 44bc1c33 · Attendance › Card Assignment — assign or clear one employment's Card / Clocking ID.
 *
 * NOTHING IS DECIDED HERE. `setEmploymentCardId` (core/attendance-card.ts) owns the whole rule set: the
 * normalisation, the cross-column collision refusal that no database constraint can express, and the audit
 * event. `requireAdmin` is this surface's own guard, not the authority — a server action is one POST away
 * from being called directly.
 *
 * A refusal comes back through `?error=` rather than as a 500, because the person typing the number needs
 * to be told WHO already holds it; a generic failure would leave them guessing.
 */

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { setEmploymentCardId } from '@/core/attendance-card';

const PAGE = '/admin/card-assignment';
const str = (v: FormDataEntryValue | null) => String(v ?? '').trim();

export async function saveCardIdAction(formData: FormData) {
  const s = await requireAdmin();
  const employmentId = str(formData.get('employmentId'));
  const cardId = str(formData.get('cardId'));
  // The filters the screen was showing, so a save returns to the same view rather than the top of the list.
  const back = new URLSearchParams();
  const q = str(formData.get('q'));
  const company = str(formData.get('company'));
  if (q) back.set('q', q);
  if (company) back.set('company', company);

  if (!employmentId) redirect(PAGE);

  try {
    // '' clears the card, which returns that employee to matching on Employee ID / IC — not to having no
    // attendance at all.
    await setEmploymentCardId(s, { employmentId, cardId: cardId === '' ? null : cardId });
  } catch (e) {
    back.set('error', (e as Error).message);
    redirect(`${PAGE}?${back.toString()}`);
  }

  revalidatePath(PAGE);
  back.set('saved', '1');
  redirect(`${PAGE}?${back.toString()}`);
}
