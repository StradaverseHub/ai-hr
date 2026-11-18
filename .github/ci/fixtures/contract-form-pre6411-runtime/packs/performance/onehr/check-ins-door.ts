/**
 * D-P1-32 PT-X5 follow-up (DQ-11) — the Performance home's door to the legacy /performance page, where manager
 * check-ins and "awaiting you" stay. Since the sidebar's manager-up Performance row became Performance admin
 * (OneHR administrators only), a manager reaches that page from Your tools instead.
 *
 * The predicate is the page's own: the viewer has manager check-ins (managerCheckIns) or pending manager reviews
 * (managerPendingReviews), the two reads /performance draws its check-ins and "awaiting you" from, under the
 * viewer's own session (RLS). Nothing else decides it.
 */
import type { SessionContext } from '../../../db/client';
import { managerCheckIns, managerPendingReviews } from '../../../core/performance';

export const CHECK_INS_HREF = '/performance';

/** The door's address when the viewer has check-ins or reviews waiting on /performance, otherwise null. */
export async function checkInsDoor(ctx: SessionContext): Promise<string | null> {
  const [checkIns, pending] = await Promise.all([managerCheckIns(ctx), managerPendingReviews(ctx)]);
  return checkIns.checkins.length > 0 || pending.length > 0 ? CHECK_INS_HREF : null;
}
