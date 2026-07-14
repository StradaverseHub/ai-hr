/**
 * Approvals sort (feedback 09cda965) — display-only ordering for the /approvals inbox.
 *
 * PURE, non-'use client' helpers so the /approvals SERVER component may import AND call them
 * (the RSC-boundary guard forbids a server page importing+calling values out of a 'use client'
 * module — the interactive dropdown lives separately in app/approvals/sort-control.tsx).
 *
 * The four options match the reporter's spec: latest / oldest / name_asc / name_desc. The sort is
 * applied per-type section in the render layer over rows already loaded newest-first — NO loader
 * ORDER BY is rewritten. Sorting is STABLE and keyed on the request id as the tie-break, so the
 * ordering is deterministic and the (separate) bulk-approval selection — keyed by request id —
 * survives a re-sort. Display-only: no data / permission / authority change.
 */
export const APPROVAL_SORTS = ['latest', 'oldest', 'name_asc', 'name_desc'] as const;
export type ApprovalSort = (typeof APPROVAL_SORTS)[number];

export const DEFAULT_APPROVAL_SORT: ApprovalSort = 'latest';

/** Coerce a raw ?sort= search-param value to a known option; anything else → latest-first default. */
export function parseApprovalSort(raw: string | string[] | undefined): ApprovalSort {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (APPROVAL_SORTS as readonly string[]).includes(v ?? '') ? (v as ApprovalSort) : DEFAULT_APPROVAL_SORT;
}

/** Accessors a caller supplies per section (each section names its own id / name / createdAt fields). */
export type ApprovalSortAccessors<T> = {
  id: (row: T) => string;
  /** Employee display name for name_asc / name_desc. Missing/blank sorts last on A–Z. */
  name: (row: T) => string | null | undefined;
  /** Submission time for latest / oldest. Accepts Date | ISO string | epoch ms. */
  createdAt: (row: T) => Date | string | number | null | undefined;
};

function toMillis(v: Date | string | number | null | undefined): number {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Return a NEW array of `rows` ordered by `sort`. Original array is not mutated. Stable across the
 * whole comparator via an explicit request-id tie-break (so re-sorting never reshuffles equal keys).
 */
export function sortApprovalRows<T>(rows: readonly T[], sort: ApprovalSort, acc: ApprovalSortAccessors<T>): T[] {
  const byId = (a: T, b: T) => acc.id(a).localeCompare(acc.id(b));
  const copy = rows.slice();
  copy.sort((a, b) => {
    let primary = 0;
    switch (sort) {
      case 'latest':
        primary = toMillis(acc.createdAt(b)) - toMillis(acc.createdAt(a));
        break;
      case 'oldest':
        primary = toMillis(acc.createdAt(a)) - toMillis(acc.createdAt(b));
        break;
      case 'name_asc':
        primary = (acc.name(a) ?? '').localeCompare(acc.name(b) ?? '');
        break;
      case 'name_desc':
        primary = (acc.name(b) ?? '').localeCompare(acc.name(a) ?? '');
        break;
    }
    return primary !== 0 ? primary : byId(a, b);
  });
  return copy;
}
