import { permanentRedirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';

/**
 * AI Centre restructure (owner decisions 26 and 29, 4 November 2026): the Operations Overview is gone. Operations opens
 * on Loops; the Overview's work queue is part of Record readiness (who acts, Refresh and what the missing-data loop
 * asked), its agreement table is part of Insights › AI quality, and its staffing ratio is removed (decision 26).
 *
 * WHY THIS FILE STILL EXISTS. Bookmarks and links in people's notes must not 404, and lib/permissions.ts registers
 * /control-tower: test/function-access.test.ts requires every registered route to exist on disk as a guarded route.
 * requireAdmin() below is therefore the unchanged guard, not decoration: a non-administrator (and an auditor, whom the
 * layout admits for the Audit loop page only) is refused here exactly as before, and only an administrator is forwarded.
 * It reads nothing. permanentRedirect (308): the move is not temporary.
 */
export default async function ControlTowerPage() {
  await requireAdmin();
  permanentRedirect('/control-tower/loops');
}
