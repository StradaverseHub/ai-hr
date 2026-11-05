import { permanentRedirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';

/**
 * AI Centre restructure (owner decisions 28 and 29, 4 November 2026): Proposed actions is part of Exceptions, the one
 * queue of payroll exceptions, as its "cause already fixed" group. The approval itself is unchanged: the same server
 * action (./actions.ts), the same blast-radius cap and the same re-check when it is pressed; it now returns there.
 *
 * WHY THIS FILE STILL EXISTS. lib/permissions.ts registers /control-tower/actions and test/function-access.test.ts
 * requires every registered route to exist as a guarded route; old links must not 404. requireAdmin() is the unchanged
 * guard: a non-administrator is refused exactly as before, and only an administrator is forwarded. It reads nothing.
 */
export default async function AgentActionsPage() {
  await requireAdmin();
  permanentRedirect('/control-tower/exceptions#fixed-causes');
}
