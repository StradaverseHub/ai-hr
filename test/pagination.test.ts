import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_ROW_CEILING,
  DEFAULT_PAGE_SIZE,
  PAGE_NUMBER_WINDOW,
  PAGE_SIZE_OPTIONS,
  lastPage,
  pageCount,
  pageHref,
  pageNumbers,
  pageOfIndex,
  pageState,
  paginateRows,
  parsePageQuery,
  parsePageSize,
  showPager,
} from '../lib/pagination';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('fc776376 — the one pagination contract', () => {
  it('defaults to 25 rows on page one when the address says nothing', () => {
    expect(parsePageQuery({})).toEqual({ page: 0, size: 25, limit: 25, offset: 0 });
    expect(DEFAULT_PAGE_SIZE).toBe(25);
  });

  it('offers 25 / 50 / 100 / 200 / All and rejects anything else', () => {
    expect([...PAGE_SIZE_OPTIONS]).toEqual([25, 50, 100, 200]);
    for (const n of PAGE_SIZE_OPTIONS) expect(parsePageSize(String(n))).toBe(n);
    expect(parsePageSize('all')).toBe('all');
    // A hand-typed or stale size is not honoured — 10,000 rows is exactly what the ceiling exists to stop.
    for (const bad of ['10000', '30', '-1', 'lots', undefined, '']) {
      expect(parsePageSize(bad)).toBe(DEFAULT_PAGE_SIZE);
    }
  });

  it('carries the page in the address as offset × size', () => {
    expect(parsePageQuery({ page: '2', size: '50' })).toEqual({ page: 2, size: 50, limit: 50, offset: 100 });
    // Negative / fractional / junk pages resolve to the first page rather than a negative offset.
    for (const bad of ['-3', 'x', '1.5']) expect(parsePageQuery({ page: bad }).offset).toBe(0);
  });

  it('"All" fetches up to the ceiling from the top, ignoring any page in the address', () => {
    expect(parsePageQuery({ page: '7', size: 'all' })).toEqual({
      page: 0,
      size: 'all',
      limit: ALL_ROW_CEILING,
      offset: 0,
    });
    expect(ALL_ROW_CEILING).toBe(2000);
  });

  it('reports position as "26-50 of 312"', () => {
    const st = pageState(parsePageQuery({ page: '1' }), 312, 25);
    expect([st.from, st.to, st.total]).toEqual([26, 50, 312]);
    expect(st.hasPrev).toBe(true);
    expect(st.hasNext).toBe(true);
  });

  it('knows the last page has no next, and the first has no previous', () => {
    const last = pageState(parsePageQuery({ page: '12' }), 312, 12);
    expect([last.from, last.to]).toEqual([301, 312]);
    expect(last.hasNext).toBe(false);
    expect(pageState(parsePageQuery({}), 312, 25).hasPrev).toBe(false);
  });

  it('reports an honest empty range for a page past the end, and still offers Previous', () => {
    const beyond = pageState(parsePageQuery({ page: '99' }), 312, 0);
    expect([beyond.from, beyond.to]).toEqual([0, 0]);
    expect(beyond.total).toBe(312);
    expect(beyond.hasNext).toBe(false);
    expect(beyond.hasPrev).toBe(true);
  });

  it('says so when "All" truncates, and does not when it fits', () => {
    const over = pageState(parsePageQuery({ size: 'all' }), 12430, ALL_ROW_CEILING);
    expect(over.truncated).toBe(true);
    expect([over.from, over.to, over.total]).toEqual([1, 2000, 12430]);
    // Truncated or not, "All" is one page — no Next to click that would silently skip the rest.
    expect(over.hasNext).toBe(false);
    expect(pageState(parsePageQuery({ size: 'all' }), 40, 40).truncated).toBe(false);
  });

  it('slices an already-loaded array with the same contract as a server-paged read', () => {
    const rows = Array.from({ length: 312 }, (_, i) => i);
    const { rows: slice, state } = paginateRows(rows, parsePageQuery({ page: '1' }));
    expect(slice[0]).toBe(25);
    expect(slice).toHaveLength(25);
    expect([state.from, state.to, state.total]).toEqual([26, 50, 312]);

    const all = paginateRows(Array.from({ length: 5000 }, (_, i) => i), parsePageQuery({ size: 'all' }));
    expect(all.rows).toHaveLength(ALL_ROW_CEILING);
    expect(all.state.truncated).toBe(true);
  });

  // REVERSED by fc776376. The pager used to hide on any list of 25 rows or fewer, which on this tenant is
  // nearly every list (23 active employees, 36 leave requests, 47 payslips) — so the reporter had never
  // seen the control and reported that pagination did not exist. It was right to believe that. What was
  // asked for is a framework that is always visible, not a control that appears once a list gets big.
  it('shows the pager chrome at EVERY row count, including the counts that used to hide it', () => {
    expect(showPager(pageState(parsePageQuery({}), 5, 5))).toBe(true);
    expect(showPager(pageState(parsePageQuery({}), 0, 0))).toBe(true);
    expect(showPager(pageState(parsePageQuery({}), 23, 23))).toBe(true);
    expect(showPager(pageState(parsePageQuery({}), 312, 25))).toBe(true);
    expect(showPager(pageState(parsePageQuery({}), 30, 25))).toBe(true);
  });

  // ── 9da61c86: the numbered strip, First and Last. ──────────────────────────────────────────────────
  it('counts the pages, and calls an empty list one empty page rather than none', () => {
    expect(pageCount(328, 25)).toBe(14);
    expect(pageCount(100, 25)).toBe(4);
    expect(pageCount(0, 25)).toBe(1);
    // "All" is one page by construction — pageState gives it no next, so there is nothing to number.
    expect(pageCount(12430, 'all')).toBe(1);
    expect(lastPage(pageState(parsePageQuery({}), 328, 25))).toBe(13);
  });

  it('offers a WINDOW of page numbers, centred and clamped, never one button per page', () => {
    const at = (page: number, total = 328) => pageNumbers(pageState(parsePageQuery({ page: String(page) }), total, 25));
    expect(PAGE_NUMBER_WINDOW).toBe(5);
    // Centred in the middle of the run…
    expect(at(6)).toEqual([4, 5, 6, 7, 8]);
    // …and slid back inside it at the ends, so the strip keeps its width instead of shrinking to two.
    expect(at(0)).toEqual([0, 1, 2, 3, 4]);
    expect(at(13)).toEqual([9, 10, 11, 12, 13]);
    // Fewer pages than the window: every page, once.
    expect(at(1, 60)).toEqual([0, 1, 2]);
  });

  // The bar itself still renders at every row count (showPager) — the size control and the counter are the
  // framework. A lone "1" beside them is not; on this tenant most lists are one page long.
  it('draws no page numbers for a list that fits on one page, or under All', () => {
    expect(pageNumbers(pageState(parsePageQuery({}), 5, 5))).toEqual([]);
    expect(pageNumbers(pageState(parsePageQuery({}), 0, 0))).toEqual([]);
    expect(pageNumbers(pageState(parsePageQuery({ size: 'all' }), 12430, ALL_ROW_CEILING))).toEqual([]);
  });

  // What the editable grids use to follow a newly added row onto whichever page it landed on.
  it('answers which page a row index falls on, and never a negative one', () => {
    expect(pageOfIndex(0, 25)).toBe(0);
    expect(pageOfIndex(24, 25)).toBe(0);
    expect(pageOfIndex(25, 25)).toBe(1);
    expect(pageOfIndex(328, 25)).toBe(13);
    // -1 is findIndex's "not in this view" — an active search hiding a still-empty draft. Page one.
    expect(pageOfIndex(-1, 25)).toBe(0);
    expect(pageOfIndex(400, 'all')).toBe(0);
  });

  it('keeps every other param when it builds a link, and drops the empty ones', () => {
    const href = pageHref('/personnel', { q: 'lee', dept: '', status: undefined, size: 50 }, { page: 3 });
    expect(href).toBe('/personnel?q=lee&size=50&page=3');
    expect(pageHref('/personnel', {}, {})).toBe('/personnel');
  });
});

describe('fc776376 — one implementation, not a sixth', () => {
  const converted = [
    'app/personnel/page.tsx',
    'app/admin/personnel/page.tsx',
    // afd0a87c — app/leave/page.tsx is OFF this list. It was converted for the org-wide leave-request
    // table, which has been removed at the reporter's request; the Employee Details listing that remains
    // has its own numbered pager (inquiryPageWindow, feedback 650b6eb8) and never used the shared <Pager>
    // or the ?size= contract. /leave/employee-records below is the surviving shared-pager leave surface.
    'app/leave/employee-records/page.tsx',
    'app/approvals/history/page.tsx',
    // f1b994e3 — 'app/admin/leave/audit/page.tsx' STOOD HERE and is now a redirect stub with no list to
    // page. Its pager, filters and export moved UP to the central Audit Trail one line above, which was
    // already on this list; the entry is removed rather than repointed because the two were one screen.
    'app/admin/audit/page.tsx',
  ];

  it.each(converted)('%s pages through the shared helper and pager', (file) => {
    const src = read(file);
    expect(src).toContain("from '@/lib/pagination'");
    expect(src).toContain('<Pager');
    // The hand-rolled page-size constants and next-page probes are gone for good.
    expect(src).not.toMatch(/const PAGE = \d+;/);
    expect(src).not.toContain('rowsPlusOne');
  });

  // Where each screen DECLARES its searchParams. Normally the page itself; 579255c3 moved the Personnel
  // listing's declaration into a shared module so the Excel export can be built from the SAME parse of
  // the SAME params. The contract is asserted where it lives rather than dropped — a page that stops
  // accepting ?size= still fails here.
  const searchParamsIn: Record<string, string> = {
    'app/admin/personnel/page.tsx': 'app/admin/personnel/list-query.ts',
  };

  it.each(converted)('%s accepts ?size= so a shared link opens the same view', (file) => {
    expect(read(searchParamsIn[file] ?? file)).toContain('size?: string;');
    // …and the page still feeds those params to the shared helper, wherever the type is declared.
    expect(read(file)).toContain('parsePageQuery(sp)');
  });

  it('every locale carries the pager strings', () => {
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const cat = JSON.parse(read(`messages/${locale}.json`)) as {
        pagination?: Record<string, string>;
      };
      for (const key of [
        'rowsPerPage',
        'all',
        'range',
        'rangeEmpty',
        'previous',
        'next',
        // 9da61c86 — the ends and the numbered strip the reporter asked for by name.
        'first',
        'last',
        'pageNumber',
        'truncated',
        'truncatedHint',
        'truncatedExport',
      ]) {
        expect(cat.pagination?.[key], `${locale}.pagination.${key}`).toBeTruthy();
      }
    }
  });

  it('leaves the non-list tables alone — config grids, statutory rates, import previews', () => {
    // Paging a config grid means saving a matrix you can only see a third of; paging an import preview
    // means approving a file you have only partly read. These are tables in layout only.
    //
    // 9da61c86 REMOVED TWO ENTRIES FROM THIS LIST, on the reporter's approved request:
    // components/grade-labels-grid.tsx and components/system-labels-grid.tsx (and, with them,
    // components/profile-options-grid.tsx, which never stood here). The rule they were classified under
    // is unchanged and still governs everything left below — but they were classified WRONGLY. A matrix
    // you save as a whole (a band grid, the access matrix) genuinely cannot be paged: you would be
    // committing a decision about rows you cannot see. These three are not matrices; they are LISTS of
    // master-data records that happen to be edited in place, one independent row at a time, and a tenant
    // has hundreds of them. Their Save still submits every dirty row in the category rather than the page
    // (test/settings-grid-paging.dom.test.tsx pins the behaviour), so nothing about paging them commits
    // an unseen decision. The entries move rather than the rule.
    for (const file of [
      'components/band-grid-editor.tsx',
      'components/function-access-grid.tsx',
      // 706d34e8 — app/admin/leave-approval/workflow-matrix.tsx STOOD HERE and the file is deleted (the
      // per-rule Approval Workflows list was removed from /admin/leave/approval and it had no other
      // importer). A config grid that no longer exists cannot grow pagination; the entry goes with it.
      'app/payroll/configuration/pcb/page.tsx',
      'app/payroll/configuration/skbbk/page.tsx',
      'app/admin/personnel/import/employee-import.tsx',
      // r424 (50ed39e1) — punch-import.tsx STOOD HERE and is deleted; the import preview is now
      // clocking-import.tsx, still a capped preview (500 rendered rows), not a paged list.
      'app/attendance/import/clocking-import.tsx',
      'app/payroll/history-import/history-import.tsx',
      'app/admin/leave/import/leave-ledger-import.tsx',
      'app/approvals/leave-date-breakdown.tsx',
    ]) {
      expect(read(file), file).not.toContain("from '@/lib/pagination'");
    }
  });
});
