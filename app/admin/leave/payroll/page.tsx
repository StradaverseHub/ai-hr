import { redirect } from 'next/navigation';

/**
 * a6fe37fc ROUND 5 (cutover) — redirect stub, and the LAST of the ten. Payroll Related is gone as a
 * screen: its two settings were not one subject, and IA §2.0's table splits them accordingly.
 *
 * ══ WHERE THE TWO HALVES WENT ════════════════════════════════════════════════════════════════════════
 *
 *   · F39 — the per-leave-type "Send to payroll module" switch — is a property of the LEAVE TYPE, and it
 *     is on tab 1 of `/admin/leave-config/types`, with the rest of what a leave type IS. Same form, same
 *     `payrollImpact=1` tri-state marker, same `updateLeaveTypeAction`, same column. The derived
 *     "Affects payroll deduction" tick-box came with it, still disabled and still never posted: it
 *     reflects whether the type is paid and has never been a control.
 *   · F40 — the per-COMPANY leave encashment policy (ADR-0069) — is a company rule, so it is on
 *     `/admin/leave-config/company-rules` with the other three, `data-tour="leave-encashment"` and all.
 *
 * THE STUB POINTS AT COMPANY RULES, which is what IA §2.0's table specifies. It is the one of the two
 * destinations that is a whole screen in its own right; the leave-type switch is one control on a tab,
 * and landing a bookmark there would open a screen with a leave type list and no obvious reason why.
 *
 * ⚠️ THIS STUB IS NEVER DELETED (migration order → Round 6).
 *
 * No guard here — the destination page enforces admin access; this stub only redirects, so it is
 * deliberately NOT a function-access column and `/admin/leave/payroll` left lib/permissions.ts's
 * leaveConfig `routes` in the SAME commit that emptied this page. `nav.leavePayroll`, the sidebar row's
 * label, is pruned in all six catalogues with the row rather than left as an untranslatable orphan —
 * the df00b85f / f1b994e3 precedent.
 */
export default async function LeavePayrollRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string') usp.set(k, v);
    else if (Array.isArray(v) && v[0] != null) usp.set(k, v[0]);
  }
  const qs = usp.toString();
  redirect(`/admin/leave-config/company-rules${qs ? `?${qs}` : ''}`);
}
