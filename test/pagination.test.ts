import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_ROW_CEILING,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  pageHref,
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
    'app/leave/page.tsx',
    'app/leave/employee-records/page.tsx',
    'app/approvals/history/page.tsx',
    'app/admin/audit/page.tsx',
    'app/admin/leave/audit/page.tsx',
  ];

  it.each(converted)('%s pages through the shared helper and pager', (file) => {
    const src = read(file);
    expect(src).toContain("from '@/lib/pagination'");
    expect(src).toContain('<Pager');
    // The hand-rolled page-size constants and next-page probes are gone for good.
    expect(src).not.toMatch(/const PAGE = \d+;/);
    expect(src).not.toContain('rowsPlusOne');
  });

  it.each(converted)('%s accepts ?size= so a shared link opens the same view', (file) => {
    expect(read(file)).toContain('size?: string;');
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
    for (const file of [
      'components/band-grid-editor.tsx',
      'components/function-access-grid.tsx',
      'components/grade-labels-grid.tsx',
      'components/system-labels-grid.tsx',
      'app/admin/leave-approval/workflow-matrix.tsx',
      'app/payroll/configuration/pcb/page.tsx',
      'app/payroll/configuration/skbbk/page.tsx',
      'app/admin/personnel/import/employee-import.tsx',
      'app/attendance/import/punch-import.tsx',
      'app/payroll/history-import/history-import.tsx',
      'app/admin/leave/import/leave-ledger-import.tsx',
      'app/approvals/leave-date-breakdown.tsx',
    ]) {
      expect(read(file), file).not.toContain("from '@/lib/pagination'");
    }
  });
});
