// Employee Leave View Configuration (feedback 65dec703 / duplicate 1fedb473).
//
// The CLOSED allow-list of leave-breakdown components an HR admin can show/hide, per leave type, in the
// employee self-service (ESS) "My Profile → Leave" surface, plus the resolver render sites use to decide
// visibility. Stored in leave_type.ess_view_config (JSONB, migration 0178) as { key: boolean }.
//
// Semantics (backward compatible): a key mapped `true` ⇒ visible; `false` ⇒ hidden in ESS; a MISSING key —
// or a null/absent config — ⇒ VISIBLE. So the default (every pre-0178 row has null) reproduces today's
// exact behaviour: all components shown. Gating applies ONLY on /me; admin/HR always see everything.
//
// This is the single source of truth shared by: the validation allow-list in core/admin.ts updateLeaveType,
// the resolver threaded into core/read.ts (leaveBalances / leaveEntitlementBreakdown), the admin checklist in
// components/leave-type-panel.tsx, and the ESS gating in app/me + components/leave/EntitlementBreakdown.

/**
 * The configurable component keys. Every key here gates a row the employee panel can actually render, and
 * every gated row has a key here — that two-way property is the whole point of the list and is pinned by
 * test/leave-ess-view-config.test.ts.
 *
 * It has shrunk repeatedly, every time because a row left the panel and its switch was left behind:
 * 11876072 dropped `upcomingApprovedLeave` with the §5 Upcoming section, and r75's pass on 1f6fd6d8 dropped
 * `entitlementToDate`, `expiredBroughtForward` and `transactionHistory` whose rows had already gone.
 *
 * 1f6fd6d8 (the reporter's REDESIGN, r86) is the largest such shrink and the reason the list now reads the
 * way it does. The employee Leave Balance Summary was rebuilt as ONE column that adds up — Eligible, YTD
 * Entitled, Brought Forward, Adjustments, Total, Taken, Pending Approval, Brought Forward Forfeited,
 * Available Balance — and the four sections that used to sit around it (Leave Utilization, Adjustments,
 * Entitlement Calculation Breakdown and the "How this adds up" reconciliation block) were removed. So:
 *   • `unplanned` / `overutilized` went with the Utilization section. Both were labels with NO value wiring
 *     anyway — an employee only ever saw an em-dash beside them.
 *   • `carryForwardExpiry` went with the Entitlement Calculation Breakdown. The expiry date did NOT
 *     disappear: it is now a sub-line ON the Brought Forward Forfeited row (which is where a reader asks the
 *     question), so it hides and shows with `forfeited`.
 *   • `entitlementCalcBreakdown` was that section's own gate and no longer names anything. It also served as
 *     the de-facto "show the breakdown side-sheet at all" switch at three call sites; those now ask
 *     `essViewHasAnyVisibleRow` below, which is the same question asked honestly.
 * ADDED in the same change: `eligible` and `total`, the two new summary lines that had no switch.
 *
 * Nine keys, one per line of the summary, in the summary's own display order — that IS the reporter's
 * synchronisation requirement (ed17a4f9), and ESS_VIEW_CHECKLIST_GROUPS derives the admin checklist from the
 * panel descriptor so the two cannot drift.
 *
 * Removing a key is safe for stored data: resolveEssView ignores keys it does not know, so a tenant's other
 * selections survive untouched, and the admin form builds its submission from THIS list so a dropped key
 * simply stops being posted. Seven of the nine keys are the ORIGINAL key strings, so every selection HR has
 * already made for those rows survives the redesign verbatim.
 *
 * The admin checklist does not render this list flat — it groups the keys by the employee panel's sections
 * via ESS_VIEW_CHECKLIST_GROUPS (components/leave/entitlement-panel-config.ts), so the configuration reads in
 * the panel's own display order. i18n labels live under `admin.leave.essView.<key>`.
 */
export const ESS_VIEW_COMPONENT_KEYS = [
  'eligible',
  'ytdEntitled',
  'broughtForward',
  'adjustment',
  'total',
  'taken',
  'pendingApproval',
  'forfeited',
  'available',
] as const;

export type EssViewComponentKey = (typeof ESS_VIEW_COMPONENT_KEYS)[number];

/** As stored on leave_type.ess_view_config — a partial map (missing key ⇒ visible). */
export type EssViewConfig = Partial<Record<EssViewComponentKey, boolean>>;

/** As threaded to render sites — every key resolved to an explicit boolean (missing ⇒ true = visible). */
export type ResolvedEssView = Record<EssViewComponentKey, boolean>;

const KEY_SET: ReadonlySet<string> = new Set(ESS_VIEW_COMPONENT_KEYS);

/** True when `k` is a known component key (used to reject unknown keys on write). */
export function isEssViewComponentKey(k: string): k is EssViewComponentKey {
  return KEY_SET.has(k);
}

/**
 * Resolve a stored (possibly null / partial) config into an explicit per-key visibility map. A missing key —
 * or a null config — resolves to `true` (visible), which is the backward-compatible default. Unknown keys in
 * the stored blob are ignored (writes are validated up front, but a read must never throw on legacy data).
 */
export function resolveEssView(config: Record<string, boolean> | null | undefined): ResolvedEssView {
  const out = {} as ResolvedEssView;
  for (const key of ESS_VIEW_COMPONENT_KEYS) {
    const v = config?.[key];
    out[key] = v === undefined ? true : !!v;
  }
  return out;
}

/**
 * Feedback 1f6fd6d8 — does this leave type still show the employee ANY line of the Leave Balance Summary?
 *
 * Replaces the `entitlementCalcBreakdown` key that three /leave call sites had quietly repurposed as "may
 * this employee open the breakdown side-sheet at all". That key named a section which no longer exists, so
 * the gate had drifted from a real question to a historical accident. The honest question is this one: a
 * side-sheet whose every row HR has hidden is an empty panel, and an empty panel should not be offered.
 *
 * Deliberately permissive: ONE visible row is enough. Anything stricter would hide a panel HR left partly
 * configured, and a MISSING key resolves to visible, so the default (no config at all) still shows it.
 */
export function essViewHasAnyVisibleRow(view: Record<string, boolean> | null | undefined): boolean {
  return ESS_VIEW_COMPONENT_KEYS.some((k) => view?.[k] !== false);
}
