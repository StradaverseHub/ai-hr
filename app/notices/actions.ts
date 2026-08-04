'use server';

import { revalidatePath } from 'next/cache';

import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { dismissNoticePopup, markNoticeViewed } from '@/core/notice';

/**
 * 6e122302 — the two writes an EMPLOYEE makes against a notice. Both are facts about themselves, both are
 * fenced by the recipient RLS policy on notice_recipient (migration 0390), and NEITHER is an
 * acknowledgement.
 *
 * `getSession`, not `requireAdmin`: these are employee actions. The row an employee can touch is decided
 * by `app.is_self_person` in the policy, not by a role check here — so a forged noticeId simply updates
 * nothing rather than someone else's record.
 */

/** Mark a notice OPENED. First open only (the service's `firstViewedAt IS NULL` guard). A page load is not
 *  consent, and this must never be presented as one. */
export async function markNoticeViewedAction(formData: FormData) {
  const s = await getSession();
  const me = await myEmployment(s);
  if (!me) return;
  const noticeId = String(formData.get('noticeId') ?? '');
  if (!noticeId) return;
  await markNoticeViewed(s, noticeId, me.employmentId);
  revalidatePath('/notices');
  revalidatePath('/');
}

/** Dismiss the login popup for this notice. Popup-frequency state only: a 'once' notice stops popping up,
 *  an 'until_acknowledged' one keeps coming back until it expires (there is nothing to acknowledge yet —
 *  see core/notice.ts popupNoticeFor for exactly what release two has to change). */
export async function dismissNoticePopupAction(formData: FormData) {
  const s = await getSession();
  const me = await myEmployment(s);
  if (!me) return;
  const noticeId = String(formData.get('noticeId') ?? '');
  if (!noticeId) return;
  await dismissNoticePopup(s, noticeId, me.employmentId);
  revalidatePath('/');
}
