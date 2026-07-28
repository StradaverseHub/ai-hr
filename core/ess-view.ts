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
 * It has shrunk twice, both times because a row was removed from the panel and its switch was left behind:
 * 11876072 dropped `upcomingApprovedLeave` with the §5 Upcoming section, and feedback 1f6fd6d8 dropped three
 * more whose rows had already gone —
 *   • `entitlementToDate` and `expiredBroughtForward`: columns removed from the balance table (776cd1b5),
 *     and §2 Entitlement Breakdown, the panel's other home for them, removed by e503f284;
 *   • `transactionHistory`: §6 Transaction History was removed UNIVERSALLY (1dd4d827), not per type, so the
 *     toggle could not re-surface it however it was set.
 * Each was a switch an HR admin could tick with no effect anywhere — the reporter's "obsolete fields".
 *
 * Removing a key is safe for stored data: resolveEssView ignores keys it does not know, so a tenant's other
 * selections survive untouched, and the admin form builds its submission from THIS list so a dropped key
 * simply stops being posted.
 *
 * The admin checklist does not render this list flat — it groups the keys by the employee panel's sections
 * via ESS_VIEW_CHECKLIST_GROUPS (components/leave/entitlement-panel-config.ts), so the configuration reads in
 * the panel's own display order. i18n labels live under `admin.leave.essView.<key>`.
 */
export const ESS_VIEW_COMPONENT_KEYS = [
  'available',
  'taken',
  'broughtForward',
  'unplanned',
  'adjustment',
  'overutilized',
  'ytdEntitled',
  'pendingApproval',
  'carryForwardExpiry',
  'forfeited',
  'entitlementCalcBreakdown',
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
