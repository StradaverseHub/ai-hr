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
};

/** The persisted per-user layout: which cards are shown, and the full ordering of available cards. */
export type DashboardLayout = { selected: string[]; order: string[] };

// ───────────────────────── Two-dimensional widget grid (feedback dashgrid) ─────────────────────────
//
// v3 turns the single-column customiser into a 2-D grid: the employee's chosen cards flow into a
// draggable FIRST ROW (`row1`) capped at MAX_FIRST_ROW columns, with a FIXED SECOND ROW (`row2`) that
// pins the standard shortcut/action cards + Planned Absences so the everyday actions always have a home.
//
// Row membership is DERIVED from the live card config (card type + the plannedAbsences key), NOT persisted
// — so the stored shape stays `{ selected, order }` and every existing saved layout keeps loading
// unchanged (back-compat: a legacy layout simply partitions into the same two rows on read). The DESIGN
// TENSION (pinning conflicts with these cards' removable/HR-configurable status) is resolved per the
// reporter's option 1: while in the fixed row they are shown but not individually removed. Grey drop-zone
// outlines + widget auto-resize are DEFERRED.

/** Maximum widgets across the draggable first row (the "top row"); extra selected cards wrap below it. */
export const MAX_FIRST_ROW = 4;

/** A layout split into the draggable first row and the fixed (pinned) second row. */
export type DashboardRows = { row1: string[]; row2: string[] };

/**
 * Split a normalised layout's SELECTED cards into the draggable first-row grid (`row1`) and the fixed
 * second row (`row2`), preserving the layout's order. `pinned` names the cards that belong to the fixed
 * row (shortcut/action cards + Planned Absences); every other selected card falls into `row1`. Pure /
 * framework-free so both the server page and the client customize island can call it.
 */
export function partitionDashboardRows(layout: DashboardLayout, pinned: Iterable<string>): DashboardRows {
  const pinnedSet = new Set(pinned);
  const row1: string[] = [];
  const row2: string[] = [];
  for (const key of layout.selected) {
    (pinnedSet.has(key) ? row2 : row1).push(key);
  }
  return { row1, row2 };
}

/**
 * Built-in default card catalog — the flattened R39 set, used as a safe fallback when a tenant has NO
 * dashboard_card_config rows yet (e.g. a tenant provisioned after the 1586d2f5 seed migration ran). This
 * guarantees the employee dashboard never renders blank: without HR config it behaves exactly like the
 * pre-578a2fcf dashboard (all seven cards shown, freely reorderable, none mandatory). Mirrors the seed in
 * migration 0212. `name`/`cardType`/`href` are English defaults (card names are HR-authored master data,
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
  { cardKey: 'plannedAbsences', name: 'Planned Absences', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 4 },
  { cardKey: 'recentlyJoined', name: 'Recently Joined', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 5 },
  { cardKey: 'upcomingEvents', name: 'Upcoming Events', cardType: 'information', href: null, employeeSelectable: true, defaultDisplay: true, mandatory: false, displayOrder: 6 },
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

  const selected = order.filter((k) => selectedSet.has(k));
  return { selected, order };
}
