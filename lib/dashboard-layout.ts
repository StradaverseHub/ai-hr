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
