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
 * The 14 configurable component keys (union of 65dec703's 13 + 1fedb473's Transaction History + Entitlement
 * Calculation Breakdown, minus 11876072's removed Upcoming Approved Leave — the §5 Upcoming section was
 * dropped from the employee panel, so its toggle is gone too; a legacy stored `upcomingApprovedLeave` entry
 * is simply ignored on read by resolveEssView, exactly like any other unknown key). The admin checklist no
 * longer renders this list flat — it groups the keys by the employee panel's sections via
 * ESS_VIEW_CHECKLIST_GROUPS (components/leave/entitlement-panel-config.ts). i18n labels live under
 * `admin.leave.essView.<key>`.
 */
export const ESS_VIEW_COMPONENT_KEYS = [
  'available',
  'taken',
  'entitlementToDate',
  'broughtForward',
  'expiredBroughtForward',
  'unplanned',
  'adjustment',
  'overutilized',
  'ytdEntitled',
  'pendingApproval',
  'carryForwardExpiry',
  'forfeited',
  'transactionHistory',
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
