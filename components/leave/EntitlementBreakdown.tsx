'use client';

/**
 * Read-only leave-entitlement breakdown entry point (shared by /me and /admin/personnel/[id]).
 *
 * Thin adapter: it owns the structural mirror of the server's leaveEntitlementBreakdown shape and hands it
 * — plus the §1 summary figures the page already loaded — to LeaveDetailsPanel,
 * the slide-out RIGHT side-sheet that renders the sections from the declarative descriptor
 * (entitlement-panel-config.ts). It NEVER imports a DB client or a server action, so it is a safe client
 * component (no RSC boundary violation).
 *
 * History: this used to be a local open/closed inline-expand card. Feedback 584edf44 turned that inline
 * expander into a modern side panel (Radix Dialog) while preserving the ?asOf= GET form (now inside the
 * panel) and the Employee Leave View Configuration (65dec703) / per-type visual (639fdf77) behaviour.
 * Substrate: read-only presentation → no DomainEvent. // substrate: read-only, no event
 */
import { LeaveDetailsPanel } from './LeaveDetailsPanel';
import type { PanelSummary } from './entitlement-panel-config';
import type { EligibilityNotice, EntitlementStatus } from '@/lib/entitlement-status';
import type { LeaveSummaryDerivation } from '@/lib/leave-summary-explain';
import type { SharedLeaveBalanceInfo } from '@/lib/shared-leave-balance';

/** Mirror of core/read.ts LeaveEntitlementBreakdown — kept structural so this stays db-free. */
export type EntitlementBreakdownData = {
  leaveTypeId: string;
  leaveType: string;
  asOf: string;
  cycleStart: string;
  /** 1f6fd6d8 — "Eligible (Full Year Entitlement)": the winning policy's whole-year days. The one summary
   *  line that is not ledger-derived. 845903a3 (r313): no longer what the Entitlement line SHOWS — that is
   *  `entitlement` below — but still the figure the proration is taken from, and named by its captions. */
  eligibleDays: number;
  /** 845903a3 (r313) — the Entitlement line's figure and the working behind it: the table allowance,
   *  whether proration applied, the eligible calendar days and divisor, the unrounded result and the
   *  rounded one. Mirrors core/read.ts, where it is derived; nothing is recomputed on the client. */
  entitlement: {
    annualEntitlementDays: number;
    prorated: boolean;
    eligibleCalendarDays: number | null;
    daysInLeaveYear: number | null;
    unroundedEntitlementDays: number;
    displayEntitlementDays: number;
    roundingApplied: boolean;
  };
  /** 31e39d74 — why the figures below are what they are: generated, configured-but-not-yet-generated,
   *  blocked on a missing earning method, or not configured at all. The panel renders a notice for the two
   *  middle states so a 0.00 is never silent. Mirrors core/read.ts. */
  entitlementStatus: EntitlementStatus;
  /** The entitlement table in force for this pair, by name (null ⇒ none). Display-only. */
  entitlementTemplateName: string | null;
  /** r212 (8ebf77ae) — WHICH ELIGIBILITY RULES EXIST AND WHY EACH ONE MISSED THIS EMPLOYEE. Present only
   *  where `entitlementStatus === 'no_eligibility_match'`: that is the one state the sentences answer, and
   *  the explanation costs several queries, so core/read.ts does not pay for it anywhere else. Plain
   *  already-resolved data (`lib/entitlement-status.ts`) — nothing here recomputes eligibility. */
  eligibility?: EligibilityNotice;
  currentYearEntitlement: number;
  /** r335 (6af80f5d) — `currentYearEntitlement` through the leave type's Rounding Method: what the grid's
   *  "Earned to Date" column and the employee's "Earned so far" card print. Mirrors core/read.ts, where it
   *  is derived; nothing is recomputed on the client. NOT an addend — the summary column keeps summing the
   *  exact figure above it, so it still closes onto the real Available Balance. */
  currentYearEntitlementRounded: number;
  monthlyAccruedToDate: number | null;
  carriedForward: number;
  carryForwardRemaining: number;
  carryForwardExpiryDate: string | null;
  forfeited: number;
  /** ADR-0066: net non-boundary `adjustment` days in the current cycle (festive/one-off/manual grants).
   *  COMMINGLED (config grants + policy-recalc corrections). r389 (62a1bec1): NO SCREEN READS IT. The panel's
   *  Adjustments line and the balance TABLE's Adjustment column both read `adjustments` below — the table
   *  used to read `configAdjustments` while the panel read `adjustments`, which is how one row printed two
   *  Adjustment figures. Kept only because the server still returns it. */
  otherAdjustments: number;
  /** 0315dac7 reconciliation partition — see core/read.ts LeaveEntitlementBreakdown for the full contract.
   *  Identity (closed by construction, every ledger row ≤ asOf in exactly one bucket):
   *    broughtForward + currentYearEntitlement + configAdjustments + systemAdjustments
   *      − forfeitedThisCycle − takenThisCycle = balance,   and   balance − pendingApproval = totalAvailable. */
  balance: number;
  pendingApproval: number;
  broughtForward: number;
  configAdjustments: number;
  systemAdjustments: number;
  forfeitedThisCycle: number;
  takenThisCycle: number;
  /** The individual CONFIG adjustment rows behind `configAdjustments` (reason + days each), so the panel can
   *  show where every adjusted day came from. System corrections are automatic ⇒ summarised, never itemised. */
  configAdjustmentItems: { effectiveOn: string; days: number; reason: string | null }[];
  /** 1f6fd6d8 roll-ups the redesigned summary reads — configAdjustments + systemAdjustments, and
   *  broughtForward + currentYearEntitlement + adjustments. Computed server-side beside the buckets they sum
   *  so the panel descriptor stays a pure pick; see core/read.ts LeaveEntitlementBreakdown.
   *  r389 (62a1bec1): `adjustments` is THE Adjustment figure on every screen — the grid column reads it too. */
  adjustments: number;
  totalEntitlement: number;
  totalAvailable: number;
  transactions: { effectiveOn: string; entryType: string; days: number; sourceRequestId: string | null; reason: string | null }[];
  /** Employee Leave View Configuration (65dec703): per-component ESS visibility (missing key ⇒ visible).
   *  Only consulted when `applyEssConfig` is set — i.e. on /me; admin/HR pass it false and see every row. */
  essView?: Record<string, boolean>;
  /** Leave Entitlement Formula Management (79011509, widened by 2bc2f2a3, narrowed by ed17a4f9): HR-authored
   *  per-item explanations, keyed by the row's field key — which since ed17a4f9 is exactly the ess-view key
   *  set (core/leave-formula.ts LEAVE_EXPLANATION_KEYS). A key present with content ⇒ that row shows an info
   *  icon whose hover tooltip carries the description + formula explanation (feedback b8b665ff). Missing key
   *  / null ⇒ no icon. Structural mirror of core/read.ts ResolvedLeaveFormula (kept db-free). */
  formulaExplanations?: Record<string, { description?: string; formula?: string } | null>;
  /** r303 (31492f74) — the per-line working HR's Leave Summary sentences are rendered from. Present only on a
   *  breakdown read with `{ derivation: true }` (the HR mounts); structural mirror of core/read.ts. */
  derivation?: LeaveSummaryDerivation;
};

/**
 * r303 (31492f74) — the HR explanation switch. Set by the two HR mounts (Employee Leave Inquiry, the Personnel
 * record); the employee's My Leave never passes it, so what an employee sees is untouched. Carries the one thing
 * the sentences need that the breakdown does not: whose shared balance the row's figures are, when they are.
 */
export type HrLeaveSummaryExplanation = {
  sharedBalance: SharedLeaveBalanceInfo | null;
  /**
   * 2a57a007 (r340) — THE POOL A BORROWER'S DAYS COME FROM, on a BORROWER's row only; null (or absent) on the
   * pool's own row, on every unpooled type, and on every mount that has not been taught this fact.
   *
   * ⚠️ IT CANNOT BE DERIVED IN HERE, AND THAT IS WHY IT IS A FIELD. `data` is the POOL's breakdown for a
   * borrower (`balanceStoryTypeId`), so `data.leaveTypeId === sharedBalance.sourceLeaveTypeId` on the
   * borrower's row AND on the pool's own row — the two are indistinguishable from what this component
   * receives. `isPoolBorrower` needs the ROW's leave type, which only the row builder has.
   *
   * What it changes: the panel STATES the borrower's own entitlement (nothing) before the figures, and the
   * Entitlement / Earned to Date sentences say whose working follows. It does NOT rewrite the figures — see
   * LeaveDetailsPanel for why the column stays the pool's whole closing arithmetic. Omit it and this panel is
   * byte-identical to what it rendered before.
   */
  entitlementFromPool?: string | null;
};

export function EntitlementBreakdown({
  data,
  summary,
  visual,
  asOf,
  action,
  hiddenParams = {},
  applyEssConfig = false,
  triggerLabel,
  triggerClassName,
  hrExplanation,
}: {
  data: EntitlementBreakdownData;
  /** §1 Leave Summary figures from the balance row (leaveBalances). */
  summary: PanelSummary;
  /** Display-only per-type theming (639fdf77): colour / icon / code. */
  visual: { color: string | null; icon: string | null; code: string | null };
  /** The current as-at date driving the view (defaults to today server-side). */
  asOf: string;
  /** The GET target of the as-at form (the page path, e.g. '/me' or '/admin/personnel/<id>'). */
  action: string;
  /** Other query params to preserve across the as-at GET (kept as hidden inputs). */
  hiddenParams?: Record<string, string | string[]>;
  /** Employee Leave View Configuration (65dec703): when true (ESS /me), gate each section/field against
   *  `data.essView` (missing key ⇒ visible). Admin/HR leave it false so everything always shows. */
  applyEssConfig?: boolean;
  /** r242 — caption + classes for the built-in trigger, forwarded verbatim. Omit both and every existing
   *  mount renders exactly what it rendered before; Employee Balances passes them because its trigger is a
   *  cell under an "Explanation" heading rather than a link stacked under a figure. Plain strings only —
   *  a translator closure crossing this boundary is a 500 (r123). */
  triggerLabel?: string;
  triggerClassName?: string;
  /** r303 — HR mounts only: replace each row's info icon with sentences explaining THIS employee's figure. */
  hrExplanation?: HrLeaveSummaryExplanation;
}) {
  return (
    <LeaveDetailsPanel
      data={data}
      summary={summary}
      visual={visual}
      asOf={asOf}
      action={action}
      hiddenParams={hiddenParams}
      applyEssConfig={applyEssConfig}
      triggerLabel={triggerLabel}
      triggerClassName={triggerClassName}
      hrExplanation={hrExplanation}
      /* r212 — the notice rides INSIDE the breakdown the server already loaded, so every page that renders
         this adapter shows it without a prop of its own. Wiring it as a sibling prop instead would have
         meant editing each of the four host pages, and the one that forgot would have silently kept the
         silence this item exists to end. */
      eligibility={data.eligibility}
    />
  );
}
