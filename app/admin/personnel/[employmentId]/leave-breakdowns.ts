/**
 * r303 (31492f74) — THE PERSONNEL RECORD'S LEAVE BREAKDOWNS, AND WHETHER HR'S SENTENCES RIDE ON THEM.
 *
 * The approved plan says the Leave Summary sentences are FOR HR ONLY. This record gates its other HR-only parts
 * (pay, statutory, the benefit scheme view) on `isAdmin(s)`, so the sentences use that SAME predicate — never a
 * second definition of "HR". For anybody else the breakdown is read exactly as before r303 (no `derivation` in
 * the payload) and the Explain panel gets no HR switch, so it keeps its icons and shows no sentences.
 *
 * OBSERVATION, recorded so nobody re-derives it: the route is behind `scopedAdmin()` → `requireAdmin()`, which
 * redirects a non-admin away before this runs, so today every viewer who reaches it passes `isAdmin`. The gate
 * here is still the one the page's own HR-only reads use, and it is what keeps the explanation HR-only if that
 * route guard is ever widened (the page's comments already describe managers viewing a report here).
 *
 * Lifted out of page.tsx so the decision is driven by a test with real sessions and RLS
 * (test/r303-personnel-leave-explain.test.ts) instead of only being grepped for.
 * Substrate: read-only, no DomainEvent. // substrate: read-only, no event
 */
import type { SessionContext } from '@/db/client';
import { leaveEntitlementBreakdown } from '@/core/read';
import { isAdmin } from '@/lib/authz';
import type { HrLeaveSummaryExplanation } from '@/components/leave/EntitlementBreakdown';
import type { SharedLeaveBalanceInfo } from '@/lib/shared-leave-balance';

/** One breakdown per balance row's leave type, at the record's as-at date — with HR's per-line working only
 *  when the viewer is an HR administrator. */
export function personnelLeaveBreakdowns(s: SessionContext, employmentId: string, leaveTypeIds: string[], asOf: string) {
  const derivation = isAdmin(s);
  return Promise.all(
    leaveTypeIds.map((id) => leaveEntitlementBreakdown(s, employmentId, id, asOf, undefined, { derivation })),
  );
}

/** The Explain panel's HR switch for one balance row: set for an HR administrator, absent for anybody else. */
export function personnelHrExplanation(
  s: SessionContext,
  sharedBalance: SharedLeaveBalanceInfo | null | undefined,
): HrLeaveSummaryExplanation | undefined {
  return isAdmin(s) ? { sharedBalance: sharedBalance ?? null } : undefined;
}
