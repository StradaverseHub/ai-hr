import { redirect } from 'next/navigation';

/**
 * My Attendance > Plan OT — MOVED IN, 2166ef79 stage one.
 *
 * The Plan OT list is now the **Self Overtime** section of My Attendance (app/attendance/requests), which
 * is where the reporter asked for it: one screen with Self Overtime, Short Hours, Incomplete Entry and
 * Absent, rather than overtime on a page of its own beside a blank correction form. The LIST did not get
 * rebuilt — the same myOvertimePlans read, the same columns, the same Withdrawn wording, the same withdraw
 * rule — it is rendered there instead of here.
 *
 * WHY THIS FILE STAYS. The nav row `/attendance/plan-ot` is staff muscle memory, it is pinned as the
 * fourth self-service row by three separate guards (test/attendance-pack.test.ts,
 * test/attendance-menu-relocation.test.ts, test/sidebar-attendance-group.test.ts), and
 * myWithdrawOvertimePlan lands its refusals here. So the route keeps resolving and forwards — exactly what
 * 0bb0e303 and 1e9145d4 did when these same forms last relocated.
 *
 * THE ERROR IS CARRIED ACROSS, deliberately. A withdrawal the service refuses ("the overtime date has
 * passed") redirects to `/attendance/plan-ot?error=…`, and a forward that dropped the query string would
 * turn a refusal into a silent no-op — the employee would press Withdraw, see the list unchanged, and be
 * told nothing. `toast` is NOT carried: no screen in this module renders it (it never has), so forwarding
 * it would only put unread text in the address bar.
 *
 * THE APPLY FORM DID NOT MOVE. `/attendance/plan-ot/apply` is untouched — same fields, same island, same
 * server action, same warnings. Only its entry point is now the "Apply overtime" button on My Attendance.
 */
export default async function PlanOtPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const q = error ? `&error=${encodeURIComponent(error)}` : '';
  // redirect() signals by THROWING — nothing may follow it here, and nothing does.
  redirect(`/attendance/requests?section=overtime${q}`);
}
