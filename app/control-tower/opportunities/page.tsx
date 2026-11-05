import { permanentRedirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';

/**
 * AI Centre restructure (owner decision 29, 4 November 2026): Opportunities is gone. Its measured part (each process's
 * cases, durations, rework and staff actions, the Assistant's outcomes and the automatic reminders) is part of Insights ›
 * HR capacity, where the stored baseline is the only minutes input; the ranked build list and its export are in
 * Administration › Build list, for group administrators only.
 *
 * WHY THIS FILE STILL EXISTS. lib/permissions.ts registers /control-tower/opportunities and test/function-access.test.ts
 * requires every registered route to exist as a guarded route; old links must not 404. requireAdmin() is the unchanged
 * guard: a non-administrator is refused exactly as before, and only an administrator is forwarded. It reads nothing.
 */
export default async function OpportunitiesPage() {
  await requireAdmin();
  permanentRedirect('/assistant?view=insights#hr-capacity');
}
