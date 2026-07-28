/**
 * Employee dashboard layout — pure, framework-free helpers (feedback 7d9d145d).
 *
 * v1 = VERTICAL reordering of the EXISTING employee dashboard sections only. Each reorderable section
 * is a "block" with a stable id; the employee's saved order is a `BlockId[]` persisted per-user on
 * `app_user.dashboard_layout` (null = the system DEFAULT_ORDER). This module holds ONLY the pure pieces
 * shared by the server page AND the client customize island — the id list, the default order, and a
 * normaliser that repairs any stored order (drops unknown ids, dedupes, appends missing blocks so a
 * newly-shipped block always surfaces). It is deliberately NOT a `'use client'` module: the server page
 * imports DEFAULT_ORDER / normalizeDashboardOrder and CALLS them, which the RSC boundary guard forbids
 * for `'use client'` exports.
 */

/** Every reorderable employee-dashboard block, in the system default (current-code) order. */
export const DEFAULT_ORDER = [
  'cards', // the employee summary card row (leave balance · next holiday · pending tasks)
  'plannedAbsences', // the planned-absences timeline strip
  'recentlyJoined', // recently-joined / onboarding card
  'upcomingEvents', // upcoming public-holidays card
  'recentActivity', // recent-activity feed
] as const;

export type DashboardBlockId = (typeof DEFAULT_ORDER)[number];

const KNOWN = new Set<string>(DEFAULT_ORDER);

/** Type guard: is `v` a known block id? */
export function isDashboardBlockId(v: unknown): v is DashboardBlockId {
  return typeof v === 'string' && KNOWN.has(v);
}

/**
 * Repair an arbitrary stored/candidate order into a complete, valid block order:
 * - non-array / null / undefined → DEFAULT_ORDER (a fresh copy)
 * - keeps only known ids, in the given order, first occurrence wins (dedupe)
 * - appends any DEFAULT_ORDER block not present, in default order, at the end
 * so the result ALWAYS contains exactly the full block set once each. This is what makes a saved
 * layout forward-compatible when a new block ships: it appears at the bottom instead of vanishing.
 */
export function normalizeDashboardOrder(raw: unknown): DashboardBlockId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ORDER];
  const seen = new Set<DashboardBlockId>();
  const out: DashboardBlockId[] = [];
  for (const v of raw) {
    if (isDashboardBlockId(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  for (const id of DEFAULT_ORDER) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** Is `order` exactly the default (same ids, same positions)? Used to short-circuit a no-op save. */
export function isDefaultOrder(order: readonly DashboardBlockId[]): boolean {
  return order.length === DEFAULT_ORDER.length && order.every((id, i) => id === DEFAULT_ORDER[i]);
}

// ───────────────────────── Add / Remove / Shortcut (feedback 578a2fcf) ─────────────────────────
//
// v2 evolves the layout from a fixed reorder-only BlockId[] into an ADD / REMOVE / SHORTCUT model driven
// by the HR-Admin Dashboard Card Master (feedback 1586d2f5). The R39 "cards" block flattens into its three
// individually-selectable summary cardKeys (leaveBalance / nextHoliday / pendingTasks); together with the
// four section blocks that gives seven default cardKeys, matching the master's seed. Employees may now
// ADD any employee-selectable card that isn't shown, REMOVE optional cards, and REORDER — but MANDATORY
// cards can never be removed, and the saved set is validated against the live HR config (unknown / disabled
// cards are dropped) instead of the old force-re-add behaviour that made "remove" impossible to persist.
//
// The stored shape widens from `cardKey[]` to `{ selected: cardKey[]; order: cardKey[] }`:
//   • `selected` — the cards the employee chose to SHOW (mandatory always included).
//   • `order`    — the full ordering of ALL available cards, so a hidden card keeps a stable slot and
//                  re-adding it restores its position.
// A legacy order-only array reads back as "everything shown, in that order" (backward compatible).

/** The subset of a master card row the pure normaliser needs. Callers pass ACTIVE cards only. */
export type DashboardCardChoice = {
  cardKey: string;
  employeeSelectable: boolean;
  defaultDisplay: boolean;
  mandatory: boolean;
  displayOrder: number;
  /**
   * OPTIONAL so every existing caller keeps compiling; supplied in practice by both real sources (the
   * tenant's dashboard_card_config rows and BUILTIN_ROLE_DASHBOARD_CARDS). The normaliser needs it only to
   * enforce the MAX_SHORTCUTS cap (feedback 3d2bc793) — with it absent no card counts as a shortcut and
   * the cap is inert, which is the correct behaviour for a caller that does not model card types.
   */
  cardType?: 'information' | 'action' | 'shortcut';
};

/** The persisted per-user layout: which cards are shown, and the full ordering of available cards. */
export type DashboardLayout = { selected: string[]; order: string[] };

// ───────────────────────── Two-dimensional widget grid (feedback dashgrid → 2806443b) ─────────────────────────
//
// v3 turned the single-column customiser into a 2-D grid; feedback 2806443b reshapes it into THREE areas:
// a draggable FIRST ROW (`row1`) of up to MAX_FIRST_ROW summary cards, a FIXED SECOND ROW (`row2`) that
// holds ONLY the Leave Calendar (plannedAbsences) stretched full width, and a flexible THIRD AREA (`row3`)
// below the calendar where every remaining selected card lands. Shortcut/action cards (incl. pendingTasks)
// are no longer pinned — they are ordinary removable/arrangeable cards.
//
// Row membership is DERIVED from FIXED_ROW_KEYS, NOT persisted — the stored shape stays `{ selected,
// order }` and every existing saved layout keeps loading unchanged (back-compat: a legacy layout simply
// partitions into the three areas on read). DESIGN DECISION: pinning (position) is deliberately NOT
// derived from the `mandatory` flag — mandatory is per-tenant HR-editable policy governing REMOVABILITY,
// and HR flagging a summary card mandatory must not yank it out of row 1 into the full-width row. If HR
// unsets plannedAbsences' mandatory flag the card stays in the fixed row with no remove control, so
// employees still cannot remove it in the UI — acceptable and intended. Grey drop-zone outlines + widget
// auto-resize are DEFERRED.

/** Maximum widgets across the draggable first row (the "top row"); extra selected cards land in row 3. */
export const MAX_FIRST_ROW = 4;

/**
 * The cardKeys pinned to the full-width fixed second row (feedback 2806443b): the Leave Calendar only.
 * The single pin rule consumed by BOTH the employee customizer and the admin settings page — position is
 * a product rule keyed on the cardKey; removability is the separate per-tenant `mandatory` flag.
 */
export const FIXED_ROW_KEYS = ['plannedAbsences'] as const;
const FIXED_ROW = new Set<string>(FIXED_ROW_KEYS);

/** Is `key` pinned to the full-width fixed second row? */
export function isFixedRowKey(key: string): boolean {
  return FIXED_ROW.has(key);
}

// ───────────────────────── The Shortcuts section (feedback 3d2bc793) ─────────────────────────
//
// Shortcut cards were ordinary cards: adding one dropped it wherever the flat order happened to put it —
// usually alone below the Leave Calendar — and there was no cap and no section to speak of. They now
// gather into their OWN row of mini cards between the top row and the pinned calendar, holding up to
// MAX_SHORTCUTS of them in an order the employee sets.
//
// Same rule as the pinned row: membership is DERIVED (from the card's HR-configured `cardType`), never
// persisted. The stored shape is still `{ selected, order }`, so a layout saved before this change loads
// unchanged and every non-shortcut card keeps exactly the position it had — only cards HR typed as
// 'shortcut' move, which is the point. 'action' cards (Pending Tasks) are deliberately NOT shortcuts:
// they render a bespoke server node in the top row and must stay there.

/** Maximum shortcut mini cards an employee may show in the Shortcuts section. */
export const MAX_SHORTCUTS = 4;

/** A layout split into the top row, the Shortcuts row, the fixed (pinned) row, and the third area below. */
export type DashboardRows = { row1: string[]; shortcuts: string[]; row2: string[]; row3: string[] };

/**
 * Split a normalised layout's SELECTED cards, preserving the layout's order: `row2` = the pinned cards
 * (`pinned` names them — the Leave Calendar per FIXED_ROW_KEYS), `shortcuts` = the cards `shortcuts` names
 * (the tenant's 'shortcut'-typed cards), `row1` = the first MAX_FIRST_ROW remaining cards, `row3` = every
 * remaining card, rendered below the calendar. Pure / framework-free so both the server page and the
 * client customize island can call it. `shortcuts` defaults to empty, which reproduces the pre-3d2bc793
 * three-way split exactly.
 */
export function partitionDashboardRows(
  layout: DashboardLayout,
  pinned: Iterable<string>,
  shortcuts: Iterable<string> = [],
): DashboardRows {
  const pinnedSet = new Set(pinned);
  const shortcutSet = new Set(shortcuts);
  const row1: string[] = [];
  const row2: string[] = [];
  const row3: string[] = [];
  const shortcutRow: string[] = [];
  for (const key of layout.selected) {
    if (pinnedSet.has(key)) row2.push(key);
    else if (shortcutSet.has(key)) shortcutRow.push(key);
    else if (row1.length < MAX_FIRST_ROW) row1.push(key);
    else row3.push(key);
  }
  return { row1, shortcuts: shortcutRow, row2, row3 };
}

/**
 * Built-in default card catalog — the flattened R39 set, used as a safe fallback when a tenant has NO
 * dashboard_card_config rows yet (e.g. a tenant provisioned after the 1586d2f5 seed migration ran). This
 * guarantees the employee dashboard never renders blank: without HR config all seven cards show, freely
 * arrangeable except the Leave Calendar, which is mandatory + pinned full width (feedback 2806443b).
 * Mirrors the seed in migration 0212 as amended by the 0296 data migration (plannedAbsences mandatory,
 * upcomingEvents/recentlyJoined display-order swap). `name`/`cardType`/`href` are English defaults (card names are HR-authored master data,
 * single-language — like leave-type names — so they are not i18n message keys).
 */
export type BuiltinDashboardCard = DashboardCardChoice & {
  name: string;
  cardType: 'information' | 'action' | 'shortcut';
  href: string | null;
};

export const BUILTIN_DASHBOARD_CARDS: BuiltinDashboardCard[] = [
  { cardKey: 'leaveBalance', name: 'Leave Balance', cardType: 'information', href: '/leave', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 1 },
  { cardKey: 'nextHoliday', name: 'Upcoming Holidays', cardType: 'information', href: '#upcoming-events', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 2 },
  { cardKey: 'pendingTasks', name: 'Pending Tasks', cardType: 'action', href: '/me', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 3 },
  // 2806443b: the Leave Calendar is MANDATORY (employees cannot remove it) and pinned full width (FIXED_ROW_KEYS).
  { cardKey: 'plannedAbsences', name: 'Leave Calendar', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: true, displayOrder: 4 },
  // 2806443b: upcomingEvents (5) / recentlyJoined (6) swapped so the default row 1 is
  // leaveBalance · nextHoliday · pendingTasks · upcomingEvents, with recentlyJoined below the calendar.
  { cardKey: 'upcomingEvents', name: 'Upcoming Events', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 5 },
  { cardKey: 'recentlyJoined', name: 'Recently Joined', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 6 },
  { cardKey: 'recentActivity', name: 'Recent Activity', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 7 },
];

/** cardKeys that carry a bespoke server-rendered node (vs a generic shortcut/action link). */
export const RENDERED_CARD_KEYS = [
  'leaveBalance',
  'nextHoliday',
  'pendingTasks',
  'plannedAbsences',
  'recentlyJoined',
  'upcomingEvents',
  'recentActivity',
  // 9606c59f — the card-wrapped manager/admin dashboard sections.
  'teamAwayToday',
  'approvalRequests',
  'upcomingReminders',
  'headcount',
  'pendingLeave',
  'companies',
  'latestPayroll',
  'attendanceOverview',
  'headcountByCompany',
  'latestPayrollRun',
] as const;
export type RenderedCardKey = (typeof RENDERED_CARD_KEYS)[number];
const RENDERED = new Set<string>(RENDERED_CARD_KEYS);
export function isRenderedCardKey(v: string): v is RenderedCardKey {
  return RENDERED.has(v);
}

/**
 * Legacy block token → the cardKeys it flattened into. Only the R39 "cards" block held multiple sub-cards;
 * every other legacy block id already equals its cardKey. Applied to any stored/candidate array so a
 * pre-578a2fcf saved order (which used block ids) migrates cleanly to the flattened cardKey set in place.
 */
const LEGACY_BLOCK_EXPANSION: Record<string, string[]> = {
  cards: ['leaveBalance', 'nextHoliday', 'pendingTasks'],
};

function expandLegacyTokens(arr: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of arr) {
    const expansion = LEGACY_BLOCK_EXPANSION[v];
    if (expansion) out.push(...expansion);
    else out.push(v);
  }
  return out;
}

const stringsOf = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];

/**
 * Repair an arbitrary stored/candidate layout into a valid `{ selected, order }` against the live HR card
 * config. This REPLACES the old force-re-add behaviour: a removed optional card stays removed.
 *
 * Rules (per feedback 578a2fcf):
 *  - `cards` are the tenant's ACTIVE master cards (caller filters status). Unknown / disabled cardKeys in
 *    the saved value are DROPPED.
 *  - No saved value (null / non-array / unrecognised object) → the HR default: every mandatory or
 *    default-display card is shown.
 *  - A legacy order-only array → "everything shown", in that order (backward compatible).
 *  - An explicit `{ selected, order }` → the saved selection, intersected with available cards.
 *  - MANDATORY cards are ALWAYS included (they cannot be removed), regardless of the saved selection.
 *  - `order` = saved order (validated + de-duped) followed by any remaining available card in HR display
 *    order, so the result covers every available card exactly once; `selected` is the order-preserving
 *    subset that is shown.
 */
export function normalizeDashboardLayout(raw: unknown, cards: readonly DashboardCardChoice[]): DashboardLayout {
  const available = cards.length > 0 ? cards : BUILTIN_DASHBOARD_CARDS;
  const availableSet = new Set(available.map((c) => c.cardKey));
  const mandatoryKeys = available.filter((c) => c.mandatory).map((c) => c.cardKey);
  const displayOrdered = [...available]
    .sort((a, b) => a.displayOrder - b.displayOrder || a.cardKey.localeCompare(b.cardKey))
    .map((c) => c.cardKey);

  let mode: 'default' | 'legacy' | 'explicit' = 'default';
  let selExplicit: string[] = [];
  let orderCandidate: string[] = [];

  if (Array.isArray(raw)) {
    mode = 'legacy';
    orderCandidate = expandLegacyTokens(stringsOf(raw));
  } else if (
    raw &&
    typeof raw === 'object' &&
    (Array.isArray((raw as { selected?: unknown }).selected) || Array.isArray((raw as { order?: unknown }).order))
  ) {
    mode = 'explicit';
    selExplicit = expandLegacyTokens(stringsOf((raw as { selected?: unknown }).selected));
    orderCandidate = expandLegacyTokens(stringsOf((raw as { order?: unknown }).order));
  }

  const selectedSet = new Set<string>();
  if (mode === 'default') {
    for (const c of available) if (c.mandatory || c.defaultDisplay) selectedSet.add(c.cardKey);
  } else if (mode === 'legacy') {
    for (const k of availableSet) selectedSet.add(k); // legacy dashboards showed every card
  } else {
    for (const k of selExplicit) if (availableSet.has(k)) selectedSet.add(k);
  }
  for (const k of mandatoryKeys) selectedSet.add(k); // mandatory can never be removed

  const seen = new Set<string>();
  const order: string[] = [];
  for (const k of orderCandidate) {
    if (availableSet.has(k) && !seen.has(k)) {
      seen.add(k);
      order.push(k);
    }
  }
  for (const k of displayOrdered) {
    if (!seen.has(k)) {
      seen.add(k);
      order.push(k);
    }
  }

  // MAX_SHORTCUTS cap (feedback 3d2bc793): enforced HERE rather than in the UI alone, because this runs on
  // both read and write — so a hand-crafted save can't exceed it, and a layout that already holds more
  // shortcuts than the cap sheds the surplus from the END, keeping the first four the employee arranged.
  // A MANDATORY shortcut is exempt: "mandatory cards can never be removed" is the older invariant and wins.
  const shortcutKeys = new Set(available.filter((c) => c.cardType === 'shortcut').map((c) => c.cardKey));
  const mandatorySet = new Set(mandatoryKeys);
  let shortcutsShown = 0;
  const selected: string[] = [];
  for (const k of order) {
    if (!selectedSet.has(k)) continue;
    if (shortcutKeys.has(k)) {
      if (shortcutsShown >= MAX_SHORTCUTS && !mandatorySet.has(k)) continue;
      shortcutsShown++;
    }
    selected.push(k);
  }
  return { selected, order };
}

// ───────────────────────── Role-aware customization (feedback 9606c59f) ─────────────────────────
//
// Managers and HR Admins get the SAME Customize Dashboard experience employees have. Two pure additions:
//
//  1. A per-ROLE built-in fallback catalog (`BUILTIN_ROLE_DASHBOARD_CARDS`): the manager/admin dashboard
//     sections card-wrapped, used when a tenant has no dashboard_card_config rows for the role — the same
//     never-render-blank guarantee employees have. `BUILTIN_DASHBOARD_CARDS` above deliberately STAYS the
//     employee set (its long-standing meaning; existing callers and saved layouts are untouched).
//
//  2. A per-ROLE stored layout shape: `app_user.dashboard_layout` evolves from one flat
//     `{ selected, order }` to `{ employee?: {…}, manager?: {…}, hr_admin?: {…} }` so a person who wears
//     two hats keeps a sensible dashboard in both. Back-compat: a LEGACY flat value (array or
//     `{ selected/order }` object) reads as the EMPLOYEE slot — existing saved employee layouts keep
//     working exactly as they are, and other roles read as "nothing saved" (the role default).
//     `extract/merge/removeRoleLayout` below are the ONLY readers/writers of that envelope; the slot value
//     itself still flows through `normalizeDashboardLayout` on every read AND write.

/** The dashboard roles a layout can be saved under — mirrors lib/dashboard-cards resolveDashboardRole. */
export const DASHBOARD_LAYOUT_ROLES = ['employee', 'manager', 'hr_admin'] as const;
export type DashboardLayoutRole = (typeof DASHBOARD_LAYOUT_ROLES)[number];

/** Is `raw` a LEGACY flat single-layout value (pre-9606c59f): an order array or `{ selected/order }`? */
function isLegacyFlatLayout(raw: unknown): boolean {
  if (Array.isArray(raw)) return true;
  return (
    !!raw &&
    typeof raw === 'object' &&
    (Array.isArray((raw as { selected?: unknown }).selected) || Array.isArray((raw as { order?: unknown }).order))
  );
}

/**
 * Pull one role's saved layout out of the stored `dashboard_layout` value. A legacy flat value is the
 * employee's layout (and null for every other role); a role-keyed envelope yields its slot; anything else
 * (null / scalar / unknown object) yields null = "nothing saved" → the caller normalises to the role default.
 * The returned slot is RAW — callers must still pass it through `normalizeDashboardLayout`.
 */
export function extractRoleLayout(raw: unknown, role: DashboardLayoutRole): unknown {
  if (raw == null) return null;
  if (isLegacyFlatLayout(raw)) return role === 'employee' ? raw : null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return (raw as Record<string, unknown>)[role] ?? null;
  }
  return null;
}

/**
 * Merge one role's (already-normalised) layout into the stored value, preserving every OTHER role's saved
 * slot untouched. A legacy flat value migrates in place: it becomes the employee slot of the envelope.
 */
export function mergeRoleLayout(
  raw: unknown,
  role: DashboardLayoutRole,
  layout: DashboardLayout,
): Partial<Record<DashboardLayoutRole, unknown>> {
  const out: Partial<Record<DashboardLayoutRole, unknown>> = {};
  for (const r of DASHBOARD_LAYOUT_ROLES) {
    const slot = extractRoleLayout(raw, r);
    if (slot != null) out[r] = slot;
  }
  out[role] = layout;
  return out;
}

/**
 * Drop one role's slot from the stored value (that role's "Reset to Default"), preserving the other roles'
 * saved slots. Returns null when nothing remains — the caller stores NULL, exactly the pre-9606c59f reset.
 */
export function removeRoleLayout(
  raw: unknown,
  role: DashboardLayoutRole,
): Partial<Record<DashboardLayoutRole, unknown>> | null {
  const out: Partial<Record<DashboardLayoutRole, unknown>> = {};
  for (const r of DASHBOARD_LAYOUT_ROLES) {
    if (r === role) continue;
    const slot = extractRoleLayout(raw, r);
    if (slot != null) out[r] = slot;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const builtinCard = (key: string): BuiltinDashboardCard => BUILTIN_DASHBOARD_CARDS.find((c) => c.cardKey === key)!;

/** The card-wrapped manager dashboard sections (9606c59f) — mirrors the 0299 seed. */
const BUILTIN_MANAGER_CARDS: BuiltinDashboardCard[] = [
  { cardKey: 'teamAwayToday', name: 'Team Away Today', cardType: 'information', href: '#planned-absences', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 1 },
  { cardKey: 'approvalRequests', name: 'Approval Requests', cardType: 'action', href: '/approvals', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 2 },
  { cardKey: 'upcomingReminders', name: 'Upcoming Reminders', cardType: 'information', href: '#upcoming-events', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 3 },
];

/** The card-wrapped HR-admin dashboard sections (9606c59f) — mirrors the 0299 seed. */
const BUILTIN_HR_ADMIN_CARDS: BuiltinDashboardCard[] = [
  { cardKey: 'headcount', name: 'Headcount', cardType: 'information', href: '/personnel', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 1 },
  { cardKey: 'pendingLeave', name: 'Pending Leave', cardType: 'information', href: '/leave', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 2 },
  { cardKey: 'companies', name: 'Companies', cardType: 'information', href: '/admin/organization', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 3 },
  // display_order 4 deliberately ties with plannedAbsences (also 4): the calendar is pinned to the fixed
  // row regardless of order, and the deterministic cardKey tie-break puts latestPayroll first.
  { cardKey: 'latestPayroll', name: 'Latest Payroll', cardType: 'information', href: '/payroll', employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 4 },
];

/** Sections shared with the employee dashboard, plus the wrapped attendance breakdown (manager + admin). */
const BUILTIN_ATTENDANCE_OVERVIEW: BuiltinDashboardCard = { cardKey: 'attendanceOverview', name: 'Attendance Overview', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 8 };

/**
 * Built-in default card catalog PER ROLE — the same never-render-blank fallback employees have, for every
 * role: used when a tenant has no active dashboard_card_config rows for that role (e.g. provisioned after
 * the 0299 seed migration ran). Mirrors the 0212 + 0296 + 0299 seeds; employee IS `BUILTIN_DASHBOARD_CARDS`.
 */
export const BUILTIN_ROLE_DASHBOARD_CARDS: Record<DashboardLayoutRole, BuiltinDashboardCard[]> = {
  employee: BUILTIN_DASHBOARD_CARDS,
  manager: [
    ...BUILTIN_MANAGER_CARDS,
    builtinCard('plannedAbsences'),
    builtinCard('upcomingEvents'),
    builtinCard('recentlyJoined'),
    builtinCard('recentActivity'),
    BUILTIN_ATTENDANCE_OVERVIEW,
  ],
  hr_admin: [
    ...BUILTIN_HR_ADMIN_CARDS,
    builtinCard('plannedAbsences'),
    builtinCard('upcomingEvents'),
    builtinCard('recentlyJoined'),
    builtinCard('recentActivity'),
    BUILTIN_ATTENDANCE_OVERVIEW,
    { cardKey: 'headcountByCompany', name: 'Headcount by Company', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 9 },
    { cardKey: 'latestPayrollRun', name: 'Latest Payroll Run', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 10 },
  ],
};
