/**
 * Client-side render pagination for the statutory BandGridEditor (feedback 02b842c7).
 *
 * The Advanced Edit (Band Table) screen now paints only the current page's rows for large tables (the EPF
 * Third Schedule has ~400 wage bands). The whole ruleset still lives in one form-state array and posts as a
 * single JSONB blob, so the safety property (statutory-band-form-roundtrip) is untouched — the only new
 * logic is the page arithmetic and the local→global index mapping, both pure and unit-tested here.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROWS_PER_PAGE,
  PAGINATION_THRESHOLD,
  ROWS_PER_PAGE_OPTIONS,
  normalizeRowsPerPage,
  pageOfIndex,
  paginate,
  toGlobalIndex,
} from '../lib/band-pagination';

describe('band pagination — configuration', () => {
  it('offers exactly the reporter-specified rows-per-page options, defaulting to 100', () => {
    expect([...ROWS_PER_PAGE_OPTIONS]).toEqual([100, 500, 1000]);
    expect(DEFAULT_ROWS_PER_PAGE).toBe(100);
    expect(PAGINATION_THRESHOLD).toBe(100);
  });
});

describe('band pagination — paginate()', () => {
  it('computes page count and slice bounds for a 401-band EPF table at 100/page', () => {
    const total = 401;
    expect(paginate(total, 100, 0)).toEqual({ page: 0, pageCount: 5, start: 0, end: 100 });
    expect(paginate(total, 100, 4)).toEqual({ page: 4, pageCount: 5, start: 400, end: 401 });
  });

  it('clamps an out-of-range page down to the last valid page (delete-last-row / shrink safety)', () => {
    // Page 9 requested but only 5 pages exist → clamp to 4.
    expect(paginate(401, 100, 9).page).toBe(4);
    // Negative page → clamp to 0.
    expect(paginate(401, 100, -3).page).toBe(0);
  });

  it('always yields at least one page, even for an empty table', () => {
    expect(paginate(0, 100, 0)).toEqual({ page: 0, pageCount: 1, start: 0, end: 0 });
  });

  it('honours 500 and 1000 rows-per-page selections', () => {
    expect(paginate(401, 500, 0)).toEqual({ page: 0, pageCount: 1, start: 0, end: 401 });
    expect(paginate(1500, 1000, 1)).toEqual({ page: 1, pageCount: 2, start: 1000, end: 1500 });
  });
});

describe('band pagination — local↔global index mapping', () => {
  it('maps an edit on page 2 to the correct global row index', () => {
    // 401 rows, 100/page, viewing page 1 (0-based) → global rows 100..199.
    const view = paginate(401, 100, 1);
    expect(view.start).toBe(100);
    // The first input on the page (local index 0) edits global row 100, not row 0.
    expect(toGlobalIndex(view.start, 0)).toBe(100);
    // The 43rd input on the page edits global row 142.
    expect(toGlobalIndex(view.start, 42)).toBe(142);
  });

  it('locates the page that contains a given global index (used to reveal a newly added row)', () => {
    expect(pageOfIndex(0, 100)).toBe(0);
    expect(pageOfIndex(99, 100)).toBe(0);
    expect(pageOfIndex(100, 100)).toBe(1);
    expect(pageOfIndex(399, 100)).toBe(3);
    // EPF inserts a new band just before the open-ended top band: after adding, new length 402,
    // the new row sits at index 400 → page 4 (the last page).
    expect(pageOfIndex(400, 100)).toBe(4);
  });
});

describe('band pagination — normalizeRowsPerPage()', () => {
  it('passes through supported options and falls back to the default otherwise', () => {
    expect(normalizeRowsPerPage(500)).toBe(500);
    expect(normalizeRowsPerPage(1000)).toBe(1000);
    expect(normalizeRowsPerPage(250)).toBe(DEFAULT_ROWS_PER_PAGE);
    expect(normalizeRowsPerPage(null)).toBe(DEFAULT_ROWS_PER_PAGE);
    expect(normalizeRowsPerPage(Number('nope'))).toBe(DEFAULT_ROWS_PER_PAGE);
  });
});
