/**
 * The ONE pagination contract for list tables (feedback fc776376).
 *
 * Before this, five screens hand-rolled their own paging with three different page sizes (25 / 50 / 100),
 * two different ways of deciding whether a next page exists (a real COUNT vs fetching limit+1), and no way
 * for the reader to change the page size. Every list table now goes through these pure helpers plus the
 * shared <Pager> so the behaviour can only be defined once.
 *
 * Deliberately NOT applied to: configuration grids you edit as a whole (grade labels, band grids, access
 * matrices, approval-workflow matrices), statutory rate tables (PCB, SKBBK), single-record breakdowns (one
 * payslip's lines, one leave request's days) and import previews. Paging a config grid means saving a
 * matrix you can only see a third of; paging an import preview means approving a file you have only partly
 * read. Those are tables in layout only — they are not lists of records.
 *
 * Pure arithmetic, no React and no DB, so the boundary cases (empty page, page past the end, the "All"
 * ceiling) are unit-testable without a browser or a database.
 */

/** Rows-per-page choices offered in the selector, plus the un-numbered "All". */
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

/** Default rows per page — what every list opens on when the address carries no `size`. */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * The hard ceiling on "All". A browser asked to draw 20,000 rows of payroll data locks up, and the request
 * itself times out before it renders. "All" therefore fetches up to this many rows and the pager SAYS SO on
 * screen when it truncates, pointing at export for the complete set — a stated limit beats a silent partial
 * list on a payroll screen.
 */
export const ALL_ROW_CEILING = 2000;

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number] | 'all';

/** What the address bar asked for, resolved into the numbers a query needs. */
export type PageQuery = {
  /** 0-based page as requested (never negative; not clamped against a total we do not know yet). */
  page: number;
  size: PageSize;
  /** Rows to fetch — the ceiling when size is 'all'. */
  limit: number;
  /** Rows to skip — always 0 when size is 'all'. */
  offset: number;
};

/** Everything the pager chrome needs, once the rows are in hand. */
export type PageState = PageQuery & {
  /** Total rows matching the current filters, ignoring pagination. */
  total: number;
  /** 1-based index of the first row shown, or 0 when the page is empty. */
  from: number;
  /** 1-based index of the last row shown, or 0 when the page is empty. */
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** "All" was asked for but `total` exceeds the ceiling — the screen must say so. */
  truncated: boolean;
  ceiling: number;
};

const isNumericSize = (v: number): v is (typeof PAGE_SIZE_OPTIONS)[number] =>
  (PAGE_SIZE_OPTIONS as readonly number[]).includes(v);

/** Normalise a `?size=` value to a supported option. Anything unrecognised falls back to the default. */
export function parsePageSize(raw: string | undefined | null): PageSize {
  if (raw === 'all') return 'all';
  const n = Number(raw);
  return Number.isFinite(n) && isNumericSize(n) ? n : DEFAULT_PAGE_SIZE;
}

/** Read `?page=` and `?size=` off a page's searchParams into the numbers a query needs. */
export function parsePageQuery(sp: { page?: string; size?: string } = {}): PageQuery {
  const size = parsePageSize(sp.size);
  // A hand-edited or truncated `?page=` (negative, fractional, non-numeric) opens the FIRST page rather
  // than being coerced into a neighbouring one — a link that half-parses should not land somewhere random.
  const asked = Number(sp.page);
  const page = size === 'all' || !Number.isSafeInteger(asked) || asked < 0 ? 0 : asked;
  return {
    page,
    size,
    limit: size === 'all' ? ALL_ROW_CEILING : size,
    offset: size === 'all' ? 0 : page * size,
  };
}

/**
 * Resolve the pager chrome from the query, the unpaginated total, and how many rows this page actually
 * returned. `shown` is passed rather than derived so a page past the end reports an honest empty range
 * (and still offers Previous) instead of a range that contains no rows.
 */
export function pageState(q: PageQuery, total: number, shown: number): PageState {
  const safeTotal = Math.max(0, total);
  const from = shown > 0 ? q.offset + 1 : 0;
  const to = shown > 0 ? q.offset + shown : 0;
  return {
    ...q,
    total: safeTotal,
    from,
    to,
    hasPrev: q.size !== 'all' && q.page > 0,
    hasNext: q.size !== 'all' && q.offset + shown < safeTotal,
    truncated: q.size === 'all' && safeTotal > ALL_ROW_CEILING,
    ceiling: ALL_ROW_CEILING,
  };
}

/**
 * Slice an already-loaded array. For lists whose read still returns every row, this gives the reader the
 * same contract as a server-paged list — 25 rows, a size control, a position counter, and the "All" ceiling
 * that keeps the browser from drawing tens of thousands of rows.
 */
export function paginateRows<T>(rows: readonly T[], q: PageQuery): { rows: T[]; state: PageState } {
  const slice = rows.slice(q.offset, q.offset + q.limit);
  return { rows: slice, state: pageState(q, rows.length, slice.length) };
}

/**
 * Build a link back to the same screen with `over` applied on top of the params already in the address.
 * Filters, sorting and the chosen page size therefore all survive a page step, and a copied link opens on
 * the view its sender was looking at. Empty / undefined values drop out so the address stays readable.
 */
export function pageHref(
  basePath: string,
  params: Record<string, string | number | undefined | null>,
  over: Record<string, string | number | undefined | null> = {},
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...over })) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * Whether the pager chrome is worth rendering at all — now ALWAYS true on a paginated list.
 *
 * This used to return `hasPrev || hasNext || truncated || total > DEFAULT_PAGE_SIZE`, hiding the whole bar
 * on any list of 25 rows or fewer. On this tenant that is nearly every list (23 active employees, 36 leave
 * requests, 47 payslips), so the reporter's reading — "there is still no pagination" — was accurate from
 * where they sat: they had never seen the control, because it had never rendered for them (fc776376).
 *
 * What was asked for is a FRAMEWORK: every list shows how many records it holds and lets you change the
 * page size, whether it holds twenty rows or five hundred. A control that appears only once a list gets
 * big is not a framework, it is a surprise. So the bar renders whenever a surface is a paginated list, and
 * the decision about whether a surface is a LIST at all is made by whether it renders a pager — not here.
 *
 * The deliberately-unpaged surfaces (approvals inbox, claims payment run, import previews, and every
 * config grid you edit as a whole) are unaffected: they never construct a PageState and never render a
 * pager, so there is nothing here to suppress. See the module header for why each is excluded.
 *
 * Kept as a function rather than inlined: it is the one place to reintroduce a suppression rule, and
 * test/pagination.test.ts pins the always-visible contract against exactly the row counts that used to
 * hide it.
 *
 * The parameter is retained as the seam a suppression rule would be reintroduced through, and every
 * caller already passes its state.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function showPager(state: PageState): boolean {
  return true;
}

/**
 * How many numbered page links the pager offers at once (9da61c86).
 *
 * A window, not the whole run: a 328-row list at 25 rows a page is 14 pages and would fit, but the same
 * list at "50 of 12,430 audit rows" is 249 — a pager that draws every number stops being a control and
 * becomes the longest thing on the screen. Five keeps the strip a fixed width at any list size, and First
 * / Last cover the ends the window cannot reach.
 */
export const PAGE_NUMBER_WINDOW = 5;

/** How many pages the list divides into. Always at least 1 — an empty list is one empty page, not zero. */
export function pageCount(total: number, size: PageSize): number {
  if (size === 'all') return 1;
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

/** The 0-based index of the final page. */
export function lastPage(state: PageState): number {
  return pageCount(state.total, state.size) - 1;
}

/**
 * The 0-based page numbers to offer as direct links, centred on the current page and clamped to the ends.
 *
 * Returns NOTHING when the list fits on one page. The bar itself still renders at every row count (see
 * showPager) — the size control and the position counter are the framework the reporter asked for — but a
 * lone "1" beside them is noise, and on this tenant most lists are one page long.
 *
 * Also nothing under "All": "All" is a single page by construction (pageState gives it no next), so a
 * number to click would be a link to where you already are.
 */
export function pageNumbers(state: PageState, window: number = PAGE_NUMBER_WINDOW): number[] {
  const count = pageCount(state.total, state.size);
  if (state.size === 'all' || count <= 1) return [];
  const span = Math.min(window, count);
  // Centre the window on the current page, then slide it back inside the run rather than clipping it, so
  // the strip keeps its width at both ends instead of shrinking to two entries on page 0.
  const start = Math.min(Math.max(0, state.page - Math.floor(span / 2)), count - span);
  return Array.from({ length: span }, (_, i) => start + i);
}

/**
 * The page a row at `index` of the filtered list falls on (9da61c86).
 *
 * The master-data grids add a row into the list they are already showing, and an appended draft on a paged
 * list lands wherever the sort puts it — usually the last page, silently, which reads as "Add Row did
 * nothing". They therefore look up the new row's page and go there. A negative index (the row is filtered
 * out of the current view) answers 0 rather than a negative page.
 */
export function pageOfIndex(index: number, size: PageSize): number {
  if (size === 'all' || index < 0) return 0;
  return Math.floor(index / size);
}
