// Leave Details Side Panel — configurable Calculation-Breakdown-Display framework (feedback 584edf44).
//
// This is the CORE of the item: a DECLARATIVE descriptor of the panel's sections + fields so a future
// breakdown line is added as ONE entry here — never a JSX change in LeaveDetailsPanel.tsx. Per the
// reporter's explicit mandate, NO leave-entitlement formula is hardcoded: a field's `select` merely PICKS
// an already-computed value out of the data the server assembled (leaveEntitlementBreakdown + leaveBalances).
// A field with NO `select` is a configured LABEL whose calculation mapping is deferred to a future
// enhancement — the panel renders it with an em-dash placeholder.
//
// ESS gating (65dec703): each section / field carries the SAME `ess-view` key HR toggles per leave type, so
// the panel honours the Employee Leave View Configuration on /me (admin/HR pass applyEssConfig=false and see
// everything). The key set is the closed allow-list in core/ess-view.ts.

import { ESS_VIEW_COMPONENT_KEYS, type EssViewComponentKey } from '@/core/ess-view';
import type { EntitlementBreakdownData } from './EntitlementBreakdown';

/**
 * The figures the redesigned Leave Summary takes from the BALANCE ROW (leaveBalances) rather than from the
 * as-at breakdown.
 *
 * Reduced to one field by 1f6fd6d8. Every other line of the summary comes from the breakdown, because the
 * whole column has to close onto the last line and only the breakdown's ledger partition guarantees that.
 * Available Balance is the exception on purpose: the reporter's requirement is verbatim that it "should
 * always reflect this amount in the leave balances amount out there", so it stays the SAME figure
 * `availableLeaveBalance` and the leave-apply popup use — never a number this screen adds up for itself.
 */
export type PanelSummary = {
  /** leaveBalances' `available` (ledger balance − pending). The authoritative bookable figure. */
  available: number;
};

/** The full data envelope a field's `select` reads from. DB-free: every value is already computed. */
export type PanelData = {
  breakdown: EntitlementBreakdownData;
  summary: PanelSummary;
};

export type PanelFieldValue = number | string | null;

export type PanelField = {
  key: string;
  /** i18n key under `leave.breakdown` for the row label. */
  labelKey: string;
  /** i18n key under `leave.breakdown` for a STATIC hover tooltip on this row — a fixed plain-English
   *  explanation of the figure (no HR config). Omit ⇒ no tooltip icon. Distinct from the HR-authored
   *  explanation (b8b665ff), which is keyed by field key and SUPERSEDES this when present. */
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
  /** A legitimately not-applicable figure is hidden rather than shown as a placeholder. */
  omitWhenNull?: boolean;
  // ── Redesigned Leave Summary presentation (feedback 1f6fd6d8) ──────────────────────────────────────
  // The reporter supplied a LAYOUT, not just a list: signed addends, two horizontal rules, two emphasised
  // result lines and an expiry date under the forfeit. All four are declared here rather than special-cased
  // in JSX, so the descriptor stays the single place the summary is defined.
  /** Prefix rendered before the label ('+' / '−'). The arithmetic is NOT done from this — every value is
   *  already signed correctly by the server; this is the reader's cue to how the column adds up. */
  sign?: '+' | '-';
  /** Draw a horizontal rule ABOVE this row — the reporter's dividing lines before Total and before
   *  Available Balance. */
  ruleBefore?: boolean;
  /** Render the row as a result line (bolder, larger) rather than an addend. Total and Available Balance. */
  emphasis?: 'result';
  /** A muted secondary line under the value — used for the Brought Forward Forfeited expiry date, which the
   *  reporter wants beside the figure it explains rather than as a row of its own. Returns null ⇒ no note. */
  noteSelect?: (d: PanelData) => string | null;
  /** i18n key under `leave.breakdown` wrapping `noteSelect`'s value (e.g. 'expiresOn' ⇒ "Expires: {date}"). */
  noteLabelKey?: string;
};

/** A DATA-DERIVED row: unlike a `PanelField` — whose label is a fixed i18n key — these rows come
 *  one-per-record out of the loaded data, so their label is user-authored text. `label` null ⇒ the panel
 *  renders its own fallback copy. Still a pure PICK: no formula, the descriptor only maps. Nothing declares
 *  one today (1f6fd6d8 removed the itemised adjustments with the §4 section); the hook is retained because
 *  it is the mechanism a future itemisation would use without a panel redesign. */
export type PanelItemRow = { key: string; label: string | null; note?: string | null; value: number };

export type PanelSection = {
  key: string;
  /** i18n key under `leave.breakdown` for the section heading. */
  labelKey: string;
  /** Optional i18n key under `leave.breakdown` for a one-line caption under the heading. */
  captionKey?: string;
  /** Display order (ascending). A future line inserts by picking an order between two existing ones. */
  order: number;
  /** Whole-section ESS gate (missing ⇒ visible). */
  essKey?: EssViewComponentKey;
  fields?: PanelField[];
  /** Extra rows PICKED one-per-record out of the data, rendered after `fields`. Returns [] ⇒ nothing renders. */
  itemsSelect?: (d: PanelData) => PanelItemRow[];
  /** ESS gate for `itemsSelect`'s rows — they are the detail BEHIND a field, so they hide with it. */
  itemsEssKey?: EssViewComponentKey;
};

/**
 * THE Leave Balance Summary — one section, one column, in the reporter's order (feedback 1f6fd6d8).
 *
 * The panel used to carry four sections that each explained the arithmetic from a different angle: a Leave
 * Summary, an Entitlement Calculation Breakdown, a Leave Utilization block and an Adjustments block, with a
 * "How this adds up" reconciliation block underneath trying to tie them together. The reporter's push-back
 * supplied the replacement verbatim — a single column that starts at what they get for the year and ends at
 * what they can book today:
 *
 *     Eligible (Full Year Entitlement)      20.00
 *     YTD Entitled  (as at today)           11.45
 *   + Brought Forward                        2.00
 *   + Adjustments                            1.00
 *   ─────────────────────────────────────────────
 *   = Total                                 14.45
 *   − Taken                                  6.50
 *   − Pending Approval                       2.00
 *   − Brought Forward Forfeited              2.00
 *       (Expires: 31/08/2026)
 *   ─────────────────────────────────────────────
 *   = Available Balance                      3.95
 *
 * WHY IT ADDS UP. Every addend is a bucket of the ledger PARTITION the server computes (0315dac7): the six
 * buckets tile every ledger row ≤ asOf, so `broughtForward + entitled + adjustments − forfeited − taken =
 * balance` is an identity, not an agreement. `totalEntitlement` and `adjustments` are those buckets summed
 * server-side (core/read.ts), which is what keeps every row here a pure PICK.
 *
 * THE IDENTITY STOPS AT `balance`, AND THE LAST TWO LINES ARE WHERE IT USED TO BREAK. Pending Approval is
 * NOT a ledger bucket — a pending request has no ledger row — and Available Balance is not computed here at
 * all: it is leaveBalances' `available` (see the `available` field below). So the last step of the column,
 * `balance − pendingApproval = Available Balance`, holds only while BOTH sides count the same pending
 * requests. Until r285 they did not: leaveBalances bounded pending by `start_date <= asOf` (3ddae357) and
 * `breakdown.pendingApproval` bounded it by nothing, so a request starting after the As-at date was
 * subtracted on this column and not in the figure underneath it, and the column visibly failed to close
 * (Mei Ling / ANNUAL / 2026-08-04: 6.00 here, 4.00 there, −12.50 implied against a printed −10.50). r285
 * gave the breakdown query the SAME predicate rather than a second rule. The claim above is an identity
 * again down to `balance`, and an identity from there to Available Balance only because one predicate now
 * decides "pending" for both reads — which is why this row must never acquire a date rule of its own.
 * test/r285-explain-panel-wording.test.ts pins it.
 *
 * THE ONE DEVIATION, AND WHY IT IS DELIBERATE. The reporter's formula reads
 * `YTD Entitled = Eligible × (days elapsed ÷ days in leave year)`. That is a PROJECTION, and it is right for
 * leave earned month by month — 57 of 67 production entitlement rows. But 10 rows grant the whole year up
 * front, and for those the full grant is already posted to the ledger on day one. Showing a part-year share
 * against an already-granted balance would make this column stop reaching Available Balance, and the
 * reporter's other, stronger requirement is that Available Balance must ALWAYS match the figure shown
 * everywhere else. So YTD Entitled renders the GRANTED-TO-DATE ledger figure: identical to the prorated
 * projection for earned-monthly types, and equal to the full grant for up-front ones. The column always adds
 * up and Available Balance is always the real balance. ed17a4f9's Formula Explanation wording is written
 * against this, not against the original formula.
 *
 * Eligible is the ONE line that is not ledger-derived — it is the winning policy's full-year days
 * (`eligibleDays`), because no ledger can say what a whole year would grant.
 *
 * r279 — AND IT IS NOW ALSO A GRID COLUMN, OFF THIS SAME FIELD. HR's Employee Balances grid gained a Full
 * Entitlement column that reads `bd.eligibleDays` and nothing else, exactly as the `eligible` field below
 * does. It is a PICK on both surfaces on purpose: `eligibleDays` is resolved once, in core/read.ts, through
 * the eligibility/band path. Anything that re-resolves a band for the grid becomes a second resolver and the
 * panel and the grid start naming two different full-year allowances.
 *
 * r279 also corrected the GRID'S NAME for the line below. The reporter asked for "YTD Entitled" to be renamed
 * "Full Entitlement"; it is the accrued-to-date figure, so that name would have understated the year by ~30%
 * — and the understatement closes on 31 December, so it would have read correctly in January, when someone
 * finally checked. The grid's label is now "Earned to Date" (`me.leaveBalanceTable.colYtdEntitled`) and the
 * full-year figure got its own column.
 *
 * r285 — AND THE PANEL NOW USES THE GRID'S WORDS. r279 deliberately left this panel reading "Eligible (full
 * year entitlement)" / "YTD entitled", on the grounds that its own wording was accurate and was the
 * reporter's verbatim column from 1f6fd6d8. It was accurate alone; beside the renamed grid it read as two
 * names for one figure, one click apart, and the same reporter said so. `leave.breakdown.field.eligible` and
 * `.ytdEntitled` now carry the grid's exact strings in all six locales — the LABELS only. The field keys
 * `eligible` / `ytdEntitled` are unchanged because `ytdEntitled` is a stored ESS component key in
 * `leave_type.ess_view_config` (core/ess-view.ts) that production rows hold, exactly as r279 handled it. The
 * tooltips are unchanged: neither quoted the old label, and both still describe the field correctly.
 * NOT renamed with them: the HR-side checklist labels `admin.leaveConfig.essView.{eligible,ytdEntitled}`
 * ("Eligible" / "YTD Entitled"), which name the same two rows on Leave Config → Employee Leave View
 * Configuration. Out of r285's scope; they are the next place this divergence will be noticed.
 *
 * Adding a future line is still ONE entry here and never a JSX change; that framework property (584edf44)
 * is unchanged, and the layout affordances the reporter asked for (signs, rules, result emphasis, the expiry
 * note) are declared as field properties for exactly that reason.
 */
export const ENTITLEMENT_PANEL_SECTIONS: PanelSection[] = [
  {
    key: 'summary',
    labelKey: 'section.summary',
    order: 1,
    fields: [
      // Eligible — the full leave year's entitlement, before proration, carry, adjustment or usage.
      {
        key: 'eligible',
        labelKey: 'field.eligible',
        essKey: 'eligible',
        tooltipKey: 'summaryTip.eligible',
        select: (d) => d.breakdown.eligibleDays,
      },
      // YTD Entitled — granted to date. See the deviation note above before changing this to a projection.
      {
        key: 'ytdEntitled',
        labelKey: 'field.ytdEntitled',
        essKey: 'ytdEntitled',
        tooltipKey: 'summaryTip.ytdEntitled',
        select: (d) => d.breakdown.currentYearEntitlement,
      },
      {
        key: 'broughtForward',
        labelKey: 'field.broughtForward',
        essKey: 'broughtForward',
        tooltipKey: 'summaryTip.broughtForward',
        sign: '+',
        select: (d) => d.breakdown.broughtForward,
      },
      // ONE Adjustments line. The config/system split the old §4 drew is retained in the data (the balance
      // table and the identity are keyed off it) but was never a distinction an employee needed.
      {
        key: 'adjustment',
        labelKey: 'field.adjustments',
        essKey: 'adjustment',
        tooltipKey: 'summaryTip.adjustments',
        sign: '+',
        select: (d) => d.breakdown.adjustments,
      },
      {
        key: 'total',
        labelKey: 'field.total',
        essKey: 'total',
        tooltipKey: 'summaryTip.total',
        ruleBefore: true,
        emphasis: 'result',
        select: (d) => d.breakdown.totalEntitlement,
      },
      {
        key: 'taken',
        labelKey: 'field.taken',
        essKey: 'taken',
        tooltipKey: 'summaryTip.taken',
        sign: '-',
        select: (d) => d.breakdown.takenThisCycle,
      },
      {
        key: 'pendingApproval',
        labelKey: 'field.pendingApproval',
        essKey: 'pendingApproval',
        tooltipKey: 'summaryTip.pendingApproval',
        sign: '-',
        select: (d) => d.breakdown.pendingApproval,
      },
      // Brought Forward Forfeited carries its expiry date as a sub-line — the reporter's "(Expires: …)".
      // 9816a5ad/r85 relocated carry expiry onto the LEAVE TYPE; `carryForwardExpiryDate` is resolved
      // through applyLeaveTypeRules, so this note already reads the type's rule and not leave_policy's.
      {
        key: 'forfeited',
        labelKey: 'field.broughtForwardForfeited',
        essKey: 'forfeited',
        tooltipKey: 'summaryTip.broughtForwardForfeited',
        sign: '-',
        select: (d) => d.breakdown.forfeitedThisCycle,
        noteSelect: (d) => d.breakdown.carryForwardExpiryDate,
        noteLabelKey: 'expiresOn',
      },
      // Available Balance — leaveBalances' figure, NOT the sum of the lines above it. Recomputing it here is
      // exactly what would let this screen and the leave-apply popup disagree, which is the thing the
      // reporter asked for in the strongest terms and which test/r75-leave-apply-available.test.ts pins.
      {
        key: 'available',
        labelKey: 'field.availableBalance',
        essKey: 'available',
        tooltipKey: 'summaryTip.available',
        ruleBefore: true,
        emphasis: 'result',
        select: (d) => d.summary.available,
      },
    ],
  },
];

/**
 * The reconciliation identity the summary's Total and Available Balance lines rest on (feedback 0315dac7).
 *
 * The "How this adds up" block that used to RENDER these six addends is gone — 1f6fd6d8 replaced it with the
 * single column above, which is the same arithmetic read top to bottom instead of restated underneath. The
 * identity itself is now MORE load-bearing, not less: `totalEntitlement` and `adjustments` (core/read.ts)
 * are sums of exactly these buckets, and it is this identity that makes the column close onto Available
 * Balance rather than merely appear to. Exported so the server-side reconciliation tests assert it directly.
 *
 *   Σ(addends · sign) = balance     and     balance − pendingApproval = totalAvailable
 */
export const RECONCILIATION_ADDENDS = [
  { key: 'broughtForward', sign: 1 as const },
  { key: 'currentYearEntitlement', sign: 1 as const },
  { key: 'configAdjustments', sign: 1 as const },
  { key: 'systemAdjustments', sign: 1 as const },
  { key: 'forfeitedThisCycle', sign: -1 as const },
  { key: 'takenThisCycle', sign: -1 as const },
] satisfies { key: keyof EntitlementBreakdownData; sign: 1 | -1 }[];

/** Σ(addends · sign) over a breakdown — must equal `breakdown.balance` for every employee, always. */
export function reconciledBalance(b: EntitlementBreakdownData): number {
  const total = RECONCILIATION_ADDENDS.reduce((sum, a) => sum + a.sign * (b[a.key] as number), 0);
  return Math.round(total * 100) / 100;
}

// ─── Admin checklist grouping (feedback 11876072, re-derived by ed17a4f9) ────────────────────────────────
//
// The Employee Leave View Configuration checklist (components/leave-type-panel.tsx, Custom step) is DERIVED
// from ENTITLEMENT_PANEL_SECTIONS, so the configuration screen can never list an item the summary does not
// render, and can never omit one it does. That is the reporter's synchronisation requirement stated as code
// rather than as a convention.
//
// Since 1f6fd6d8 there is exactly ONE group — the Leave Summary — holding all nine keys in the summary's own
// display order. The trailing "Other" bucket is retained and empty: it is the mechanism that makes a FUTURE
// orphaned key VISIBLE in the admin screen instead of silently unreachable, and the builder drops it while
// it stays empty.

/** One group of the admin ESS-view checklist: a panel section (heading = the section's own title) + the
 *  ess-view keys it gates. `labelKey` is the section's i18n key under `leave.breakdown`; null ⇒ the trailing
 *  "Other" group (admin-side heading `admin.leave.essView.groupOther`) collecting keys no section references. */
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
      // A section-level gate lists first, then field gates in the section's own display order — the
      // checklist reads exactly like the panel.
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
