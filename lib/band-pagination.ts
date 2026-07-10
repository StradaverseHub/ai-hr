/**
 * Pure pagination arithmetic for the statutory BandGridEditor (feedback 02b842c7).
 *
 * The EPF Third Schedule tables carry ~400 wage bands each; rendering every <input> row at once makes the
 * Advanced Edit (Band Table) screen slow to open and awkward to scroll. BandGridEditor renders only the
 * current page's slice while keeping the full `rows` array in the parent form state (so the whole ruleset
 * still round-trips byte-identically to one JSONB blob — see statutory-band-form-roundtrip.test.ts). All the
 * page maths lives here as pure functions so the fiddly local→global index mapping is unit-testable without
 * mounting React.
 */

/** Rows-per-page choices offered in the selector. */
export const ROWS_PER_PAGE_OPTIONS = [100, 500, 1000] as const;

/** Default rows per page (smallest option — fastest first paint). */
export const DEFAULT_ROWS_PER_PAGE = 100;

/**
 * Pagination is auto-enabled only when a table has MORE than this many rows. SOCSO/EIS/PCB tables (tens of
 * rows) render with no pagination chrome and behave exactly as before; only the big EPF tables paginate.
 */
export const PAGINATION_THRESHOLD = 100;

export type PageView = {
  /** Clamped 0-based current page (always within [0, pageCount - 1]). */
  page: number;
  /** Total number of pages (always >= 1, even for an empty table). */
  pageCount: number;
  /** Global index of the first row shown on this page. */
  start: number;
  /** Global index one past the last row shown (exclusive; clamped to totalRows). */
  end: number;
};

/**
 * Resolve a requested (possibly out-of-range) page into a clamped view over `totalRows`, given
 * `rowsPerPage`. Clamping means removing the last row on a page, or shrinking rowsPerPage, can never strand
 * the view past the end — the caller always gets a valid slice.
 */
export function paginate(totalRows: number, rowsPerPage: number, page: number): PageView {
  const per = rowsPerPage > 0 ? rowsPerPage : DEFAULT_ROWS_PER_PAGE;
  const pageCount = Math.max(1, Math.ceil(totalRows / per));
  const clamped = Math.min(Math.max(0, Math.trunc(page)), pageCount - 1);
  const start = clamped * per;
  const end = Math.min(start + per, totalRows);
  return { page: clamped, pageCount, start, end };
}

/** Which 0-based page a given global row index falls on, at the current rows-per-page. */
export function pageOfIndex(globalIndex: number, rowsPerPage: number): number {
  const per = rowsPerPage > 0 ? rowsPerPage : DEFAULT_ROWS_PER_PAGE;
  return Math.max(0, Math.floor(globalIndex / per));
}

/** Map a row's page-local index back to its index in the full `rows` array. */
export function toGlobalIndex(pageStart: number, localIndex: number): number {
  return pageStart + localIndex;
}

/** Normalise a stored/loaded rows-per-page value to a supported option (falls back to the default). */
export function normalizeRowsPerPage(value: number | null | undefined): number {
  return ROWS_PER_PAGE_OPTIONS.includes(value as (typeof ROWS_PER_PAGE_OPTIONS)[number])
    ? (value as number)
    : DEFAULT_ROWS_PER_PAGE;
}
