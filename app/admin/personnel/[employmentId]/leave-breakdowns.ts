/**
 * r303 (31492f74) — THE PERSONNEL RECORD'S LEAVE BREAKDOWNS, AND WHETHER HR'S SENTENCES RIDE ON THEM.
 *
 * Lifted out of page.tsx so the one decision this file exists for can be driven by a test with a real session
 * (test/r303-personnel-leave-explain.test.ts) instead of only being grepped for.
 */
import type { SessionContext } from '@/db/client';
import { leaveEntitlementBreakdown } from '@/core/read';
import type { HrLeaveSummaryExplanation } from '@/components/leave/EntitlementBreakdown';
import type { SharedLeaveBalanceInfo } from '@/lib/shared-leave-balance';

/** One breakdown per balance row's leave type, at the record's as-at date. */
export function personnelLeaveBreakdowns(s: SessionContext, employmentId: string, leaveTypeIds: string[], asOf: string) {
  return Promise.all(
    leaveTypeIds.map((id) => leaveEntitlementBreakdown(s, employmentId, id, asOf, undefined, { derivation: true })),
  );
}

/** The Explain panel's HR switch for one balance row. */
export function personnelHrExplanation(
  s: SessionContext,
  sharedBalance: SharedLeaveBalanceInfo | null | undefined,
): HrLeaveSummaryExplanation | undefined {
  return { sharedBalance: sharedBalance ?? null };
}
