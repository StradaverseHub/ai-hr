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

// ─── Replacement Leave columns (feedback 00307068) ──────────────────────────────────────────────────────
//
// A SECOND closed key set, resolved BY LEAVE TYPE CODE, not a widening of the nine above.
//
// WHY A SECOND SET RATHER THAN MORE KEYS. Replacement Leave is not a yearly allowance, so the nine-line
// Leave Balance Summary is the wrong shape for it: it is a stack of separately earned credits, each banked
// on its own day and each lapsing on its own date. Its employee panel is therefore a TABLE with six
// COLUMNS, and a column is not a summary row. Adding them to ESS_VIEW_COMPONENT_KEYS would let HR tick
// "Approval Date" on Annual Leave, where it names nothing and would render as an unexplained blank — the
// exact drift ed17a4f9 spent an item removing. Two sets, resolved by code, makes that unrepresentable:
// a non-REPLACEMENT type can never be configured with a replacement column, and vice versa.
//
// NOTHING IS DELETED. The nine keys, every stored selection under them, and every consumer that imports
// ESS_VIEW_COMPONENT_KEYS directly are byte-identical. Callers that want the set for a SPECIFIC type ask
// `essViewKeysForCode`; callers that mean "the summary's nine" keep naming them.
//
// i18n labels live under `admin.leave.essView.<key>` and the panel's own headings under
// `leave.breakdown.field.<key>`, following the nine keys' naming so a column can never be called one thing
// in the configuration and another on the screen.

/**
 * The Replacement Leave per-credit table's columns, in the table's own left-to-right display order.
 *
 * 5ff7daff ADDED `remaining` — "how much of THIS credit is still unused", the reporter's fourth column.
 * The figure has existed on every row since 0113 (`ReplacementCreditRow.remaining` = daysCredited −
 * daysTaken) and was already handed to the client; only the column was missing. It is a SIXTH key rather
 * than a rename of an existing one because the other five all still name what they named — see the
 * board plan's warning about proposing renames for columns that are already live.
 *
 * It is deliberately NOT called `available`: that string is one of the nine summary keys, and the two sets
 * are asserted DISJOINT (test/replacement-leave-column-config.test.ts). The heading an employee reads is
 * `leave.breakdown.replacement.col.remaining` = "Available"; the KEY has to be the one that cannot collide.
 */
export const REPLACEMENT_COLUMN_KEYS = [
  'requestDate',
  'number',
  'unit',
  'approvalDate',
  'expiredDate',
  'remaining',
] as const;

export type ReplacementColumnKey = (typeof REPLACEMENT_COLUMN_KEYS)[number];

const REPLACEMENT_KEY_SET: ReadonlySet<string> = new Set(REPLACEMENT_COLUMN_KEYS);

/** The leave-type code the TOIL seed writes for the type whose panel is the per-credit table. */
export const REPLACEMENT_LEAVE_CODE = 'REPLACEMENT';

/** `leave_type.role` for replacement leave — the tenant-independent marker (core/leave.ts LEAVE_TYPE_ROLES). */
export const REPLACEMENT_LEAVE_ROLE = 'replacement';

/**
 * 5ff7daff — THE ROLE MARKER, here too, and why it had to come.
 *
 * `isReplacementLeaveCode` compares against the code the SEED writes. Production's catalogue was not
 * seeded: the customer's own replacement type is coded `RL`, with `role = 'replacement'`. So every
 * comparison in this file was silently false for the type the employee actually holds — the exact failure
 * `leaveTypeIs` (core/leave.ts, 65f466e2) was introduced to fix for EMERGENCY vs production's `EL`, and
 * TOIL never adopted it. The visible symptom was two Replacement Leave cards on My Leave: the customer's
 * own (which matched nothing, so it rendered the wrong panel and could never show a credit) and an
 * auto-created `REPLACEMENT` one (which matched, and collected every credit).
 *
 * Role wins; an UNCLASSIFIED row (role null/empty) falls back to the seeded code, so nothing changes for a
 * tenant nobody has classified. Identical precedence to `leaveTypeIs`, deliberately — one rule, stated
 * twice only because this module must stay importable by client components (core/leave.ts is not).
 */
export type LeaveTypeIdent = { role?: string | null; code?: string | null };

/**
 * A caller that has the whole leave-type row passes it; a caller that only has a code passes the code.
 * The string form is kept because most call sites genuinely only carry a code (and because dropping it
 * would rewrite five files for no behavioural gain) — it simply cannot answer the role question, which is
 * why the sites that decide what an employee SEES were all moved onto the object form.
 */
export type LeaveTypeRef = LeaveTypeIdent | string | null | undefined;

const identOf = (ref: LeaveTypeRef): LeaveTypeIdent =>
  typeof ref === 'string' || ref == null ? { code: ref ?? null } : ref;

/** True when this leave-type code renders the Replacement Leave per-credit table. Case-insensitive because
 *  `code` is HR-entered free text everywhere else it is compared (core/toil.ts lowercases it too).
 *  CODE-ONLY by design — `isReplacementLeaveType` is the one that also asks the role. */
export function isReplacementLeaveCode(code: string | null | undefined): boolean {
  return (code ?? '').trim().toUpperCase() === REPLACEMENT_LEAVE_CODE;
}

/** Is this leave type the replacement one? Role first, seeded code as the fallback. */
export function isReplacementLeaveType(ref: LeaveTypeRef): boolean {
  const lt = identOf(ref);
  if (lt.role != null && lt.role !== '') return lt.role === REPLACEMENT_LEAVE_ROLE;
  return isReplacementLeaveCode(lt.code);
}

/** The configurable key set for ONE leave type — the six columns for Replacement Leave, the nine summary
 *  rows for every other type. This is the single place the split is decided; nothing else branches on it. */
export function essViewKeysForCode(ref: LeaveTypeRef): readonly string[] {
  return isReplacementLeaveType(ref) ? REPLACEMENT_COLUMN_KEYS : ESS_VIEW_COMPONENT_KEYS;
}

/** True when `k` is configurable FOR THIS LEAVE TYPE. A mismatched key must still be rejected on write —
 *  that refusal is what keeps the two sets from leaking into each other's types. */
export function isEssViewComponentKeyForCode(ref: LeaveTypeRef, k: string): boolean {
  return isReplacementLeaveType(ref) ? REPLACEMENT_KEY_SET.has(k) : KEY_SET.has(k);
}

/** Resolve a stored config for ONE leave type. Same semantics as `resolveEssView` (missing ⇒ visible,
 *  unknown stored keys ignored) but over that type's own key set. */
export function resolveEssViewForCode(
  ref: LeaveTypeRef,
  config: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of essViewKeysForCode(ref)) {
    const v = config?.[key];
    out[key] = v === undefined ? true : !!v;
  }
  return out;
}
