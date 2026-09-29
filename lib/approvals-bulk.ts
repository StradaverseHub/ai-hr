/**
 * Bulk-approval shared helpers (feedback fb99474b — "Bulk Approval Function for Managers and HR Admin").
 *
 * PURE, server-callable module (NOT 'use client'): the server page imports the types + row descriptors from
 * here, and the client selection island (app/approvals/bulk-selection.tsx) imports the same helpers — so the
 * RSC-boundary guard (test/rsc-boundary-guard.test.ts) stays satisfied. Nothing here touches React/DOM.
 *
 * v1 scope (approved as recommended in the plan): bulk covers the request kinds that today have a single
 * one-click approve/reject on /approvals — leave (ordinary), leave cancellations, claims and attendance
 * corrections (which also carry OT). Multi-level manager/HR reviews, profile-change requests, per-date
 * leave and resignations are EXCLUDED (they need per-item data), and the UI says so.
 *
 * b833a077 (r362) — TRAVEL WAS THE FIFTH MEMBER OF BOTH UNIONS AND IS GONE. My Travel was removed
 * completely: no travel request can be created and none can be decided, so there is no travel row to
 * select. Both unions and both ordered lists lose 'travel' in ONE change, because the dispatcher switch
 * in app/approvals/actions.ts and the category switch in core/approvals-summary.ts are keyed off them —
 * shrink a union without dropping its case (or the reverse) and tsc fails.
 */

/** Which core decide* service a selected row is dispatched to (the bulk server action switches on this). */
export type BulkDecideType = 'leave' | 'leaveCancellation' | 'claim' | 'attendance';

/** Confirmation-dialog breakdown bucket. Attendance corrections split into Attendance vs Overtime: an
 *  attendance correction that carries `requestedOtMinutes` is an OT request, otherwise a clock correction.
 *  Both dispatch to the SAME decideAttendanceCorrection service (type stays 'attendance'). */
export type BulkCategory = 'leave' | 'leaveCancellation' | 'attendance' | 'overtime' | 'claim';

/** A selectable pending row handed from the server page to the client island. `id` is the request id — the
 *  selection is keyed by (type,id) so it is index-independent and survives a re-sort (sort item 09cda965). */
export type BulkRow = { id: string; type: BulkDecideType; category: BulkCategory };

/** One item posted back to the bulk server action. */
export type BulkDecideItem = { type: BulkDecideType; id: string };

export const BULK_DECIDE_TYPES: readonly BulkDecideType[] = [
  'leave',
  'leaveCancellation',
  'claim',
  'attendance',
];

/** Stable display order of the by-type breakdown lines in the confirmation dialog. */
export const BULK_CATEGORY_ORDER: readonly BulkCategory[] = [
  'leave',
  'leaveCancellation',
  'attendance',
  'overtime',
  'claim',
];

/** Composite selection key. Request ids are UUIDs (globally unique) but prefixing with the type keeps the
 *  key meaningful and defends against any cross-kind id collision. */
export function bulkRowKey(r: { type: BulkDecideType; id: string }): string {
  return `${r.type}:${r.id}`;
}

/**
 * THE single Attendance-vs-Overtime split rule (feedback 2dec6406 — Approval category panel): an
 * attendance-correction row that carries `requestedOtMinutes` is an OVERTIME request; otherwise it is a
 * clock-time correction. The approvals page's bulkRows, the category module's row filter and the decided-
 * count service all import THIS predicate, so the rule can never fork.
 */
export function isOvertimeCorrection(row: { requestedOtMinutes: number | null }): boolean {
  return row.requestedOtMinutes != null;
}

/** By-type counts for a selection, in BULK_CATEGORY_ORDER, omitting empty buckets. */
export function computeBulkBreakdown(rows: BulkRow[]): { category: BulkCategory; count: number }[] {
  const counts = new Map<BulkCategory, number>();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return BULK_CATEGORY_ORDER.filter((c) => (counts.get(c) ?? 0) > 0).map((category) => ({
    category,
    count: counts.get(category)!,
  }));
}

/**
 * Run one decision per item, isolating each in its own try/catch so a single failure (a permission denial,
 * an already-decided row, a missing reject reason) is a SKIP — never fatal to the rest of the batch. Returns
 * the approved/skipped tallies for the result toast. `decideOne` is expected to open its own DB transaction
 * per item (every core decide* service does), so a skip also rolls back only that one item. Pure + generic
 * so it lives in this client-safe module and is unit-testable without Next; the server action supplies the
 * real dispatcher.
 */
export async function runBulkDecide<T>(
  items: T[],
  decideOne: (item: T) => Promise<void>,
): Promise<{ approved: number; skipped: number }> {
  let approved = 0;
  let skipped = 0;
  for (const item of items) {
    try {
      await decideOne(item);
      approved += 1;
    } catch {
      skipped += 1;
    }
  }
  return { approved, skipped };
}

/** Parse + validate the `items` JSON posted to the bulk server action. Drops anything malformed or of an
 *  unknown type so a hand-crafted payload can never dispatch to an unexpected service. */
export function parseBulkItems(raw: string): BulkDecideItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: BulkDecideItem[] = [];
  const seen = new Set<string>();
  for (const el of parsed) {
    if (!el || typeof el !== 'object') continue;
    const type = (el as { type?: unknown }).type;
    const id = (el as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) continue;
    if (typeof type !== 'string' || !BULK_DECIDE_TYPES.includes(type as BulkDecideType)) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue; // de-dupe: never decide the same request twice in one batch
    seen.add(key);
    out.push({ type: type as BulkDecideType, id });
  }
  return out;
}
