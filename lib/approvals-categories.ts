/**
 * Approval task categories (feedback 2dec6406 — "Internal Approval Task Navigation Panel").
 *
 * PURE, non-'use client' helpers (the lib/approvals-sort.ts pattern) so the /approvals SERVER page may
 * import AND call them. Built ON the bulk taxonomy, not beside it: the navigable categories reuse
 * BulkCategory (one shared Attendance-vs-Overtime split via isOvertimeCorrection) and add the people
 * categories the bulk flow deliberately excludes (profile changes, resignations, the two review stages).
 *
 * ONE CONSISTENCY RULE: every number for a category derives from the SAME population its pending list
 * renders — the page computes panel badges, the Pending card, section-heading counts and the header total
 * from the already-loaded in-memory lists (never a SQL pending count), so badge = card = heading by
 * construction. Only the three DECIDED buckets (approved/rejected/cancelled) come from SQL — see
 * core/approvals-summary.ts.
 */
import { BULK_CATEGORY_ORDER, isOvertimeCorrection, type BulkCategory } from './approvals-bulk';

export type ApprovalCategory =
  | 'all'
  | BulkCategory
  // 5ff7daff — replacement leave. NOT a BulkCategory: bulk covers the kinds that today carry a single
  // one-click approve/reject with nothing an approver must read first, and a replacement claim is a list of
  // worked dates whose whole point is that they are checked line by line. Same exclusion, same reason, as
  // profile changes and per-date leave.
  | 'replacementLeave'
  | 'profileChanges'
  | 'resignations'
  | 'managerReviews'
  | 'hrReviews';

/** Categories beyond the bulk taxonomy — the people matters, in panel order. */
const PEOPLE_CATEGORIES = ['profileChanges', 'resignations', 'managerReviews', 'hrReviews'] as const;

/**
 * Every category in canonical order: all first, then the bulk taxonomy, then replacement leave, then the
 * people categories.
 *
 * A CATEGORY MUST BE HERE OR IT DOES NOT EXIST. `parseApprovalCategory` coerces anything absent from this
 * list to 'all', so a category added to the union and to PANEL_GROUPS but not to THIS array renders a panel
 * link that silently lands back on the unfiltered inbox — nothing throws and nothing logs. 5ff7daff shipped
 * exactly that mistake for one commit and test/replacement-leave-approval-surface.test.ts is what found it.
 */
export const APPROVAL_CATEGORIES: readonly ApprovalCategory[] = [
  'all',
  ...BULK_CATEGORY_ORDER,
  'replacementLeave',
  ...PEOPLE_CATEGORIES,
];

/** Categories whose queue only an admin carries (decide authz lives in the services; this only shapes
 *  the panel + the URL-param coercion so a manager deep-link never shows an admin-only view). */
export const ADMIN_ONLY_CATEGORIES: readonly ApprovalCategory[] = [
  'profileChanges',
  'resignations',
  'hrReviews',
];

/**
 * Coerce a raw ?category= search-param value to a known category. BOTH unknown values AND admin-only
 * categories for a non-admin viewer coerce to 'all' — so a manager deep-linking ?category=profileChanges
 * lands on the full inbox instead of a nonzero card above an empty list.
 */
export function parseApprovalCategory(
  raw: string | string[] | undefined,
  opts: { admin: boolean },
): ApprovalCategory {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !(APPROVAL_CATEGORIES as readonly string[]).includes(v)) return 'all';
  const cat = v as ApprovalCategory;
  if (!opts.admin && ADMIN_ONLY_CATEGORIES.includes(cat)) return 'all';
  return cat;
}

/** Panel group headings, in display order (item order within derives from BULK_CATEGORY_ORDER). */
export type ApprovalCategoryGroup = 'leave' | 'attendance' | 'claims' | 'travel' | 'people';

export const PANEL_GROUPS: readonly {
  group: ApprovalCategoryGroup;
  categories: readonly Exclude<ApprovalCategory, 'all'>[];
}[] = [
  { group: 'leave', categories: ['leave', 'leaveCancellation', 'replacementLeave'] },
  { group: 'attendance', categories: ['attendance', 'overtime'] },
  { group: 'claims', categories: ['claim'] },
  { group: 'travel', categories: ['travel'] },
  { group: 'people', categories: PEOPLE_CATEGORIES },
];

/**
 * The page's rendered sections. NB: attendance corrections and overtime share ONE section Card —
 * 'corrections' — so attendance vs overtime is a ROW-level filter (correctionsRowFilter), not a
 * section toggle.
 */
export type ApprovalSection =
  | 'leave'
  | 'leaveCancellation'
  | 'replacementLeave'
  | 'claims'
  | 'corrections'
  | 'travel'
  | 'profileChanges'
  | 'resignations'
  | 'managerReviews'
  | 'hrReviews';

const SECTION_FOR_CATEGORY: Record<Exclude<ApprovalCategory, 'all'>, ApprovalSection> = {
  leave: 'leave',
  leaveCancellation: 'leaveCancellation',
  replacementLeave: 'replacementLeave',
  attendance: 'corrections',
  overtime: 'corrections',
  claim: 'claims',
  travel: 'travel',
  profileChanges: 'profileChanges',
  resignations: 'resignations',
  managerReviews: 'managerReviews',
  hrReviews: 'hrReviews',
};

/** Whether a page section renders under the selected category ('all' shows every section). */
export function sectionVisible(category: ApprovalCategory, section: ApprovalSection): boolean {
  if (category === 'all') return true;
  return SECTION_FOR_CATEGORY[category] === section;
}

/**
 * Row filter for the SHARED corrections section: 'attendance' keeps non-OT rows, 'overtime' keeps OT rows,
 * anything else keeps both. Uses the one shared split predicate so the panel, the bulk breakdown and the
 * decided counts can never disagree on what "overtime" means.
 */
export function correctionsRowFilter(
  category: ApprovalCategory,
): (row: { requestedOtMinutes: number | null }) => boolean {
  if (category === 'attendance') return (row) => !isOvertimeCorrection(row);
  if (category === 'overtime') return (row) => isOvertimeCorrection(row);
  return () => true;
}

/**
 * The ONE return-URL builder every /approvals decide action redirects through (success AND error paths),
 * so a decision never drops the viewer's chosen category or sort. category 'all'/'' is the default view
 * and is omitted from the query string.
 */
export function approvalsReturnUrl(p: {
  category?: string;
  sort?: string;
  toast?: string;
  error?: string;
}): string {
  const qs = new URLSearchParams();
  if (p.category && p.category !== 'all') qs.set('category', p.category);
  if (p.sort) qs.set('sort', p.sort);
  if (p.toast) qs.set('toast', p.toast);
  if (p.error) qs.set('error', p.error);
  const s = qs.toString();
  return s ? `/approvals?${s}` : '/approvals';
}
