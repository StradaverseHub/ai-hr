'use client';

/**
 * Read-only leave-entitlement breakdown entry point (shared by /me and /admin/personnel/[id]).
 *
 * Thin adapter: it owns the structural mirror of the server's leaveEntitlementBreakdown shape and hands it
 * — plus the §1 summary figures and §5 upcoming-approved list the page already loaded — to LeaveDetailsPanel,
 * the slide-out RIGHT side-sheet that renders the seven sections from the declarative descriptor
 * (entitlement-panel-config.ts). It NEVER imports a DB client or a server action, so it is a safe client
 * component (no RSC boundary violation).
 *
 * History: this used to be a local open/closed inline-expand card. Feedback 584edf44 turned that inline
 * expander into a modern side panel (Radix Dialog) while preserving the ?asOf= GET form (now inside the
 * panel) and the Employee Leave View Configuration (65dec703) / per-type visual (639fdf77) behaviour.
 * Substrate: read-only presentation → no DomainEvent. // substrate: read-only, no event
 */
import { LeaveDetailsPanel } from './LeaveDetailsPanel';
import type { PanelSummary, UpcomingLeaveItem } from './entitlement-panel-config';

/** Mirror of core/read.ts LeaveEntitlementBreakdown — kept structural so this stays db-free. */
export type EntitlementBreakdownData = {
  leaveTypeId: string;
  leaveType: string;
  asOf: string;
  cycleStart: string;
  currentYearEntitlement: number;
  monthlyAccruedToDate: number | null;
  carriedForward: number;
  carryForwardRemaining: number;
  carryForwardExpiryDate: string | null;
  forfeited: number;
  /** ADR-0066: net non-boundary `adjustment` days in the current cycle (festive/one-off/manual grants).
   *  Re-added for §4 Adjustments + balance reconciliation (was previously dropped by this mirror type). */
  otherAdjustments: number;
  totalAvailable: number;
  transactions: { effectiveOn: string; entryType: string; days: number; sourceRequestId: string | null }[];
  /** Employee Leave View Configuration (65dec703): per-component ESS visibility (missing key ⇒ visible).
   *  Only consulted when `applyEssConfig` is set — i.e. on /me; admin/HR pass it false and see every row. */
  essView?: Record<string, boolean>;
  /** Leave Entitlement Formula Management (79011509): HR-authored per-component explanations, keyed by the §7
   *  calcBreakdown field key. A key present with content ⇒ the breakdown row shows an info icon that expands to
   *  the description + formula (feedback b8b665ff). Missing key / null ⇒ no icon. Structural mirror of
   *  core/read.ts ResolvedLeaveFormula (kept db-free). */
  formulaExplanations?: Record<string, { description?: string; formula?: string; result?: string } | null>;
};

export function EntitlementBreakdown({
  data,
  summary,
  upcoming,
  visual,
  asOf,
  action,
  hiddenParams = {},
  applyEssConfig = false,
}: {
  data: EntitlementBreakdownData;
  /** §1 Leave Summary figures from the balance row (leaveBalances). */
  summary: PanelSummary;
  /** §5 Upcoming Approved Leave — approved + future requests for this leave type. */
  upcoming: UpcomingLeaveItem[];
  /** Display-only per-type theming (639fdf77): colour / icon / code. */
  visual: { color: string | null; icon: string | null; code: string | null };
  /** The current as-at date driving the view (defaults to today server-side). */
  asOf: string;
  /** The GET target of the as-at form (the page path, e.g. '/me' or '/admin/personnel/<id>'). */
  action: string;
  /** Other query params to preserve across the as-at GET (kept as hidden inputs). */
  hiddenParams?: Record<string, string>;
  /** Employee Leave View Configuration (65dec703): when true (ESS /me), gate each section/field against
   *  `data.essView` (missing key ⇒ visible). Admin/HR leave it false so everything always shows. */
  applyEssConfig?: boolean;
}) {
  return (
    <LeaveDetailsPanel
      data={data}
      summary={summary}
      upcoming={upcoming}
      visual={visual}
      asOf={asOf}
      action={action}
      hiddenParams={hiddenParams}
      applyEssConfig={applyEssConfig}
    />
  );
}
