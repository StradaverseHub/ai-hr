// Leave Details Side Panel — configurable Calculation-Breakdown-Display framework (feedback 584edf44).
//
// This is the CORE of the item: a DECLARATIVE descriptor of the panel's sections + fields so a future
// breakdown line is added as ONE entry here — never a JSX change in LeaveDetailsPanel.tsx. Per the
// reporter's explicit mandate, NO leave-entitlement formula is hardcoded: a field's `select` merely PICKS
// an already-computed value out of the data the server assembled (leaveEntitlementBreakdown + leaveBalances
// + the loaded requests). A field with NO `select` is a configured LABEL whose calculation mapping is
// deferred to a future enhancement — the panel renders it with an em-dash placeholder. That is exactly how
// §3 Utilization (Unplanned / Overutilized) and §2 "Expired Brought Forward" are surfaced today: the label
// and display order are configurable now; the value wiring lands later without a redesign.
//
// ESS gating (65dec703): each section / field carries the SAME `ess-view` key HR toggles per leave type, so
// the panel honours the Employee Leave View Configuration on /me (admin/HR pass applyEssConfig=false and see
// everything). The key set is the closed allow-list in core/ess-view.ts.

import { ESS_VIEW_COMPONENT_KEYS, type EssViewComponentKey } from '@/core/ess-view';
import type { EntitlementBreakdownData } from './EntitlementBreakdown';

/** §1 Leave Summary figures — sourced from the balance row (leaveBalances) the page already loaded. */
export type PanelSummary = {
  available: number;
  taken: number;
  pending: number;
  /** YTD Entitled = the accrued figure (accrual + in-lieu accrual to date). */
  ytdEntitled: number;
  /** §1 Balance (877f2f37): the authoritative ledger remaining figure — b.balance from leaveBalances (= sum of
   *  ledger days), passed in by the call site GROSS of pending (6574c6b4). Formerly re-derived by a helper here
   *  that double-counted carried/adjustments/taken over the ledger sum; now a plain pass-through, so the panel and
   *  the balance table always agree. Display only — no entitlement-engine change. */
  balance: number;
};

/** The full data envelope a field's `select` reads from. DB-free: every value is already computed. */
export type PanelData = {
  breakdown: EntitlementBreakdownData;
  summary: PanelSummary;
};

export type PanelFieldValue = number | string | null;

export type PanelField = {
  key: string;
  /** i18n key under `leave.breakdown` (e.g. 'field.available' or a legacy '<name>' key for §7). */
  labelKey: string;
  /** §1 Leave Summary (877f2f37): i18n key under `leave.breakdown` for a STATIC hover tooltip on this row —
   *  a fixed plain-English explanation of the figure (no HR config). Omit ⇒ no tooltip icon. Distinct from the
   *  §7 formula info-icon (b8b665ff), which is click-to-expand HR-authored content keyed by field key. */
  tooltipKey?: string;
  /** Employee Leave View Configuration key (missing ⇒ visible). Omit ⇒ the field is never ESS-gated. */
  essKey?: EssViewComponentKey;
  /** 'days' → 2dp number; 'date' → the string or the noExpiry label. Default 'days'. */
  format?: 'days' | 'date';
  /**
   * Pull the value out of PanelData. OMITTED ⇒ a configured label with an em-dash placeholder — the
   * framework deliberately lets a label exist NOW while its calculation mapping is wired in a FUTURE
   * enhancement (no hardcoded formula, no UI redesign). A `select` that returns null renders the same
   * placeholder.
   */
  select?: (d: PanelData) => PanelFieldValue;
  /** §7 only: a legitimately not-applicable figure (e.g. monthly accrual on a grant-on-open type) is
   *  hidden rather than shown as a placeholder, matching the legacy inline breakdown's behaviour. */
  omitWhenNull?: boolean;
};

export type PanelSection = {
  key: string;
  /** i18n key under `leave.breakdown` for the section heading. */
  labelKey: string;
  /** Display order (ascending). A future line inserts by picking an order between two existing ones. */
  order: number;
  // The `kind` discriminator ('upcoming' §5 list / 'transactions' §6 ledger) is GONE: with §6 removed
  // (1dd4d827) and §5 removed (11876072), every remaining section is plain label/value field rows.
  /** Whole-section ESS gate (missing ⇒ visible). */
  essKey?: EssViewComponentKey;
  fields?: PanelField[];
};

/**
 * The seven sections of the reporter's expected_function, declared with order + labels + field mappings.
 * Iterated by LeaveDetailsPanel; adding a breakdown line = one entry here.
 */
export const ENTITLEMENT_PANEL_SECTIONS: PanelSection[] = [
  // §1 Leave Summary
  {
    key: 'summary',
    labelKey: 'section.summary',
    order: 1,
    // Reordered (877f2f37) to read the way employees think — from what they were granted, through what they've
    // used, to what's left: YTD Entitled → Taken → Pending Approval → Available → Balance. Each row carries a
    // STATIC hover tooltip (tooltipKey; no HR config). Balance is the authoritative ledger remaining figure,
    // PICKED from the precomputed d.summary.balance (the call site passes b.balance directly, 6574c6b4) so this
    // stays a declarative pick, not a hardcoded formula in the descriptor.
    fields: [
      { key: 'ytdEntitled', labelKey: 'field.ytdEntitled', essKey: 'ytdEntitled', tooltipKey: 'summaryTip.ytdEntitled', select: (d) => d.summary.ytdEntitled },
      { key: 'taken', labelKey: 'field.taken', essKey: 'taken', tooltipKey: 'summaryTip.taken', select: (d) => d.summary.taken },
      { key: 'pendingApproval', labelKey: 'field.pendingApproval', essKey: 'pendingApproval', tooltipKey: 'summaryTip.pendingApproval', select: (d) => d.summary.pending },
      { key: 'available', labelKey: 'field.available', essKey: 'available', tooltipKey: 'summaryTip.available', select: (d) => d.summary.available },
      // Balance has no essKey (never ESS-gated) — it is the headline reconciled remaining figure and always shows.
      { key: 'balance', labelKey: 'field.balance', tooltipKey: 'summaryTip.balance', select: (d) => d.summary.balance },
    ],
  },
  // §2 Entitlement Breakdown — REMOVED (feedback e503f284): the employee saw two overlapping sections,
  // "Entitlement Breakdown" (§2) and "Entitlement Calculation Breakdown" (§7). §7 is the fuller of the two, so
  // §2 is dropped from the panel and §7 is promoted to order 2 (immediately after the summary) — see below. No
  // backend data is removed; the underlying figures still feed §7. The removal is a pure display change (the
  // descriptor entry is dropped, exactly like the §6 transaction-history removal), so no leave figure changes.
  // §3 Leave Utilization — NOT computed by the engine today. Per the no-hardcoded-formula mandate these are
  // configured labels with em-dash placeholders, wired to the framework so the values land later.
  {
    key: 'utilization',
    labelKey: 'section.utilization',
    order: 3,
    fields: [
      { key: 'unplanned', labelKey: 'field.unplanned', essKey: 'unplanned' },
      { key: 'overutilized', labelKey: 'field.overutilized', essKey: 'overutilized' },
    ],
  },
  // §4 Adjustments
  {
    key: 'adjustments',
    labelKey: 'section.adjustments',
    order: 4,
    fields: [
      { key: 'adjustment', labelKey: 'field.adjustment', essKey: 'adjustment', select: (d) => d.breakdown.otherAdjustments },
    ],
  },
  // §5 Upcoming Leave — REMOVED (feedback 11876072): the reporter asked for the Upcoming Leave subsection to
  // be dropped from BOTH the admin Employee Leave View Configuration and the employee panel. The descriptor
  // entry (and its `upcomingApprovedLeave` ess-view key, removed from core/ess-view.ts) is gone, so no leave
  // type can re-surface it; a legacy stored toggle is ignored on read (resolveEssView drops unknown keys).
  // Approved-future requests are untouched data — they still show in the /leave Leave History list.
  // §6 Transaction History — REMOVED (feedback 1dd4d827): universally hidden from the breakdown side-sheet to
  // keep the panel focused on balance/entitlement. Ledger data is untouched and stays visible in the /leave
  // Leave History table. The removal is deliberately universal, not the per-leave-type `transactionHistory` ESS
  // toggle — the descriptor entry is dropped so no leave type can re-surface it here.
  // §7 Entitlement Calculation Breakdown — the existing calculation details from the current engine, verbatim.
  // Promoted to order 2 (feedback e503f284): now the single entitlement explanation, shown immediately after the
  // Leave Summary in the spot the removed §2 "Entitlement Breakdown" used to hold. Sections render by ascending
  // `order`, so 2 places it right after the summary (order 1) and ahead of Utilization/Adjustments/Upcoming.
  {
    key: 'calcBreakdown',
    labelKey: 'section.calcBreakdown',
    order: 2,
    essKey: 'entitlementCalcBreakdown',
    fields: [
      { key: 'currentYearEntitlement', labelKey: 'currentYearEntitlement', select: (d) => d.breakdown.currentYearEntitlement },
      { key: 'monthlyAccrued', labelKey: 'monthlyAccrued', omitWhenNull: true, select: (d) => d.breakdown.monthlyAccruedToDate },
      { key: 'carriedForward', labelKey: 'carriedForward', select: (d) => d.breakdown.carriedForward },
      { key: 'carryForwardRemaining', labelKey: 'carryForwardRemaining', select: (d) => d.breakdown.carryForwardRemaining },
      { key: 'carryForwardExpiry', labelKey: 'carryForwardExpiry', format: 'date', select: (d) => d.breakdown.carryForwardExpiryDate },
      { key: 'forfeited', labelKey: 'forfeited', select: (d) => d.breakdown.forfeited },
      { key: 'totalAvailable', labelKey: 'totalAvailable', select: (d) => d.breakdown.totalAvailable },
    ],
  },
];

// ─── Admin checklist grouping (feedback 11876072) ───────────────────────────────────────────────────────────
//
// The Employee Leave View Configuration checklist (components/leave-type-panel.tsx, Custom step) used to be a
// FLAT grid over ESS_VIEW_COMPONENT_KEYS. It now mirrors the employee panel: the checkboxes are grouped into
// the SAME sections, in the SAME order, the panel above renders — derived HERE from ENTITLEMENT_PANEL_SECTIONS
// so the two can never drift (one source of grouping). Each checkbox keeps its exact key and therefore its
// exact current effect; only the admin-side arrangement changed.

/** One group of the admin ESS-view checklist: a panel section (heading = the section's own title) + the
 *  ess-view keys it gates. `labelKey` is the section's i18n key under `leave.breakdown`; null ⇒ the trailing
 *  "Other" group (admin-side heading `admin.leave.essView.groupOther`) collecting keys no section references
 *  (legacy toggles that gate other surfaces, e.g. the balance-table columns) so nothing is orphaned. */
export type EssViewChecklistGroup = {
  key: string;
  labelKey: string | null;
  keys: EssViewComponentKey[];
};

export const ESS_VIEW_CHECKLIST_GROUPS: EssViewChecklistGroup[] = (() => {
  const seen = new Set<EssViewComponentKey>();
  const groups: EssViewChecklistGroup[] = [...ENTITLEMENT_PANEL_SECTIONS]
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      // A section-level gate (e.g. calcBreakdown's entitlementCalcBreakdown) lists first, then field gates in
      // the section's own display order — the checklist reads exactly like the panel.
      const keys: EssViewComponentKey[] = [];
      if (s.essKey && !seen.has(s.essKey)) {
        keys.push(s.essKey);
        seen.add(s.essKey);
      }
      for (const f of s.fields ?? []) {
        if (f.essKey && !seen.has(f.essKey)) {
          keys.push(f.essKey);
          seen.add(f.essKey);
        }
      }
      return { key: s.key, labelKey: s.labelKey, keys };
    })
    .filter((g) => g.keys.length > 0);
  const other = ESS_VIEW_COMPONENT_KEYS.filter((k) => !seen.has(k));
  if (other.length > 0) groups.push({ key: 'other', labelKey: null, keys: other });
  return groups;
})();
