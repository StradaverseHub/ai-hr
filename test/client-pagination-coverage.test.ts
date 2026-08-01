/**
 * The six browser-side list grids are paginated, and their selection cannot outrun the page (fc776376).
 *
 * These six were skipped when pagination was first built, because <Pager> is an async SERVER component
 * (it awaits getTranslations) and a 'use client' grid cannot render it. The feedback table is the one
 * that mattered: 517 rows on production, the largest list in the product, and the one the reporter
 * noticed. components/client-pager.tsx is the variant that unblocks them.
 *
 * Source assertions rather than DOM assertions because this repo has no DOM or interaction test runner
 * (carried debt item 1). They are deliberately shallow — they pin that each grid slices its rows and
 * renders the bar, not how it looks. The arithmetic itself is covered by test/pagination.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/** Every list grid that sorts or filters in the browser. */
const CLIENT_GRIDS = [
  'app/feedback/bulk-table.tsx',
  'components/loan-list.tsx',
  'components/salary-history-table.tsx',
  'app/payroll/transaction-view/history-table.tsx',
  'app/payroll/transaction-view/individual-table.tsx',
  'components/roster-grid.tsx',
];

/** Grids carrying a multi-select whose action applies to the selection. */
const SELECTING_GRIDS = ['app/feedback/bulk-table.tsx', 'components/roster-grid.tsx'];

describe('client-side list grids are paginated', () => {
  it.each(CLIENT_GRIDS)('%s slices its rows and renders the pager', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/useClientPageQuery\(\)/);
    expect(src).toMatch(/paginateRows\(/);
    expect(src).toMatch(/<ClientPager state=\{state\}/);
  });

  // The ordering that makes sorting mean what it says. Sorting must order the WHOLE matching set and
  // paging must slice the result; do it the other way and clicking a column header reorders twenty-five
  // rows while leaving the rest where they were, which looks like sorting and is not.
  it('sorts before it pages, never within the page', () => {
    const salary = read('components/salary-history-table.tsx');
    expect(salary.indexOf('.sort(')).toBeLessThan(salary.indexOf('paginateRows('));
    const individual = read('app/payroll/transaction-view/individual-table.tsx');
    expect(individual.indexOf('.sort(')).toBeLessThan(individual.indexOf('paginateRows('));
    // Both page the already-ordered set, not the raw rows.
    expect(salary).toMatch(/paginateRows\(filtered, /);
    expect(individual).toMatch(/paginateRows\(sorted, /);
  });

  // "Approve all" must never quietly mean "approve all 517". The submitted set is intersected with the
  // visible page, so the guarantee is structural rather than a matter of clearing state at the right time.
  it.each(SELECTING_GRIDS)('%s confines its selection to the visible page', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/pageIds\.has|pageEmployees\.map\(\(e\) => e\.employmentId\)/);
    expect(src).not.toMatch(/new Set\(rows\.map\(\(r\) => r\.id\)\)/);
  });

  it('tells the reviewer that a bulk selection covers this page only', () => {
    expect(read('app/feedback/bulk-table.tsx')).toMatch(/bulkPageScope/);
    const en = JSON.parse(read('messages/en.json')) as { feedback: Record<string, string> };
    expect(en.feedback.bulkPageScope).toBeTruthy();
  });

  // The client pager exists precisely because the server one cannot be awaited inside a client grid.
  it('the client pager is a client module and does not import the server pager', () => {
    const src = read('components/client-pager.tsx');
    expect(src.startsWith("'use client';")).toBe(true);
    expect(src).not.toMatch(/next-intl\/server/);
    expect(src).toMatch(/useTranslations/);
  });
});
