/**
 * The ONE pagination contract for list tables (feedback fc776376).
 *
 * Before this, five screens hand-rolled their own paging with three different page sizes (25 / 50 / 100),
 * two different ways of deciding whether a next page exists (a real COUNT vs fetching limit+1), and no way
 * for the reader to change the page size. Every list table now goes through these pure helpers plus the
 * shared <Pager> so the behaviour can only be defined once.
 *
 * Deliberately NOT applied to: configuration grids you edit as a whole (band grids, access matrices,
 * approval-workflow matrices), statutory rate tables (PCB, SKBBK), single-record breakdowns (one payslip's
 * lines, one leave request's days) and import previews. Paging a config grid means saving a matrix you can
 * only see a third of; paging an import preview means approving a file you have only partly read. Those are
 * tables in layout only — they are not lists of records.
 *
 * GRADE LABELS LEFT THAT LIST IN 9da61c86, and the old classification is recorded here rather than quietly
 * deleted because the RULE it belonged to is unchanged and still governs everything else in the sentence
 * above. It read "configuration grids you edit as a whole (grade labels, …)" — but Settings → System
 * Labels → Job Grades is not a matrix. It is the job-grade MASTER: one record per row, added to and
 * searched exactly like the position and department lists beside it, and it grows with the tenant rather
 * than with the product. Its sibling grids (System Labels, Profile Options) page for the same reason. What
 * still excludes a surface is that a PARTIAL VIEW WOULD MAKE THE SAVE WRONG — a matrix whose cells are
 * meaningful only together, an import preview you are approving unread — and that is not true of these
 * three: each sorts and filters its whole set before slicing, and Save submits every dirty row in the
 * category rather than the rows the page happens to be showing. Editable is not the test; whole-artifact
 * is. Do not re-add them here without changing that.
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

// ── Capped totals and keyset paging (ADR 0181 decision 5, Phase 4) ─────────────────────────────────────────────────
//
// An on-screen list total is exact below LIST_COUNT_CAP rows and "1,000+" above it, with an explicit "Count exactly"
// action (`?count=exact`) for the reader who needs the number. Exports, payroll, statutory and report totals are never
// capped: this contract is for on-screen list totals only.
//
// A keyset list pages by the last (or first) row it showed rather than by OFFSET: `?after=<id>` continues after that
// row, `?before=<id>` steps back before it, and `?last=1` opens the final page (offered only when the total is exact).
// The cursor is the row's own identifier, never its sort values, so names and other personal data never travel in the
// address; the reader resolves the anchor row's sort key in SQL under the same row security as the list. `page` rides
// along for the position counter only ("26–50 of 1,000+"); it never decides which rows are read.

/** On-screen list totals are exact below this and "1,000+" at or above it (owner decision, 24 November 2026). */
export const LIST_COUNT_CAP = 1000;

/** A list total: `count` is exact unless `capped`, when the list holds more than `count` rows. */
export type ListTotal = { count: number; capped: boolean };

/** The count cap a page read uses: the on-screen cap, or the "All" ceiling when that is larger. */
export function listCountCap(size: PageSize): number {
  return size === 'all' ? Math.max(LIST_COUNT_CAP, ALL_ROW_CEILING) : LIST_COUNT_CAP;
}

/** Turn "how many rows the bounded count saw" into a ListTotal. The bounded count reads at most `cap + 1` rows. */
export function cappedTotal(seen: number, cap: number, exact = false): ListTotal {
  return !exact && seen > cap ? { count: cap, capped: true } : { count: Math.max(0, seen), capped: false };
}

const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the address asked a keyset list for. `offset` is always 0: a keyset read never skips rows. */
export type KeysetPageQuery = PageQuery & {
  /** Continue after this row (Next). */
  after?: string;
  /** Step back before this row (Previous). */
  before?: string;
  /** The final page (Last). */
  last: boolean;
  /** "Count exactly" was asked for. */
  exactCount: boolean;
};

/** Read `?page=&size=&after=&before=&last=&count=` into a keyset query. A malformed cursor opens the first page. */
export function parseKeysetPageQuery(
  sp: { page?: string; size?: string; after?: string; before?: string; last?: string; count?: string } = {},
): KeysetPageQuery {
  const base = parsePageQuery(sp);
  const exactCount = sp.count === 'exact';
  if (base.size === 'all') return { ...base, offset: 0, last: false, exactCount };
  const after = sp.after && ROW_ID.test(sp.after) ? sp.after.toLowerCase() : undefined;
  const before = !after && sp.before && ROW_ID.test(sp.before) ? sp.before.toLowerCase() : undefined;
  const last = !after && !before && sp.last === '1';
  // Without a cursor the list opens on its first rows, so the counter must say page 0 whatever `page` claims.
  const page = after || before ? Math.max(after ? 1 : 0, base.page) : 0;
  return { ...base, page, offset: 0, after, before, last, exactCount };
}

/** What a keyset reader returns besides its rows. */
export type KeysetRead = {
  total: ListTotal;
  /** Rows exist before the first row shown. */
  hasPrev: boolean;
  /** Rows exist after the last row shown. */
  hasNext: boolean;
  /** False when the cursor's row is no longer visible; the reader then served the first page. */
  anchorFound: boolean;
};

export type KeysetPageState = PageState & Pick<KeysetPageQuery, 'after' | 'before' | 'last'> & {
  mode: 'keyset';
  capped: boolean;
  exactCount: boolean;
  /** Identifier of the first and last row shown, the cursors for Previous and Next. */
  firstId: string | null;
  lastId: string | null;
  /** Last is offered only when the total is exact (the final page's position is then known). */
  canLast: boolean;
};

/** Resolve the pager chrome for a keyset list from its query, its read and the identifiers of the rows shown. */
export function keysetPageState(q: KeysetPageQuery, read: KeysetRead, shownIds: readonly string[]): KeysetPageState {
  const shown = shownIds.length;
  const total = read.total.count;
  let page = read.anchorFound ? q.page : 0;
  if (q.last && !read.total.capped && q.size !== 'all') page = Math.max(0, pageCount(total, q.size) - 1);
  const size = q.size === 'all' ? 0 : q.size;
  // Before-reads near the start can leave the counter ahead of the rows (rows were deleted meanwhile): clamp it.
  if (!read.hasPrev) page = 0;
  let from = shown > 0 ? page * size + 1 : 0;
  let to = shown > 0 ? from + shown - 1 : 0;
  if (!read.total.capped && to > total) { to = total; from = Math.max(1, total - shown + 1); }
  return {
    ...q,
    page,
    total,
    from,
    to,
    hasPrev: q.size !== 'all' && read.hasPrev,
    hasNext: q.size !== 'all' && read.hasNext,
    truncated: q.size === 'all' && read.hasNext,
    ceiling: ALL_ROW_CEILING,
    mode: 'keyset',
    capped: read.total.capped,
    exactCount: q.exactCount,
    firstId: shownIds[0] ?? null,
    lastId: shownIds[shown - 1] ?? null,
    canLast: !read.total.capped && q.size !== 'all' && read.hasNext,
  };
}

export function isKeysetPageState(state: PageState): state is KeysetPageState {
  return (state as Partial<KeysetPageState>).mode === 'keyset';
}

/** Rows a keyset read fetches: one more than the page, to learn whether another page follows. */
export function keysetReadLimit(q: Pick<PageQuery, 'limit'>): number {
  return q.limit + 1;
}

/** Trim a keyset read's rows to the page and work out which neighbours exist. Rows of a `before` or `last` read
 *  arrive in reverse order and are put back in list order here. */
export function keysetSlice<T>(
  rows: readonly T[], q: Pick<KeysetPageQuery, 'limit' | 'after' | 'before' | 'last'>, anchorFound: boolean,
): { rows: T[]; hasPrev: boolean; hasNext: boolean } {
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const backwards = (q.before !== undefined && anchorFound) || q.last;
  if (backwards) return { rows: page.reverse(), hasPrev: more, hasNext: q.before !== undefined };
  return { rows: page, hasPrev: q.after !== undefined && anchorFound, hasNext: more };
}
