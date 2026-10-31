/**
 * WP-C (APR-022) — the HOD department view screen and its pure model. Who is in the population, and the
 * stored overall, are pinned against real RLS in test/performance-department-view.test.ts.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

vi.mock('next/navigation', () => ({ usePathname: () => '/performance/department', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { DepartmentViewScreen } from '../app/(app)/performance/onehr/department-view';
import { departmentForest, departmentSpread, fixedHalfEven, formatOverallScore, formatSpreadPct, pickDepartmentCycle, type DepartmentCycle, type DepartmentViewRow } from '../packs/performance/onehr/department-view-model';

const t = en.onehr.department;
afterEach(cleanup);

const person = (over: Partial<DepartmentViewRow> & { employmentId: string; fullName: string }): DepartmentViewRow => ({
  parentEmploymentId: null, department: 'Finance', jobTitle: 'Executive', direct: true, finalized: false, overallBand: null, overallScore: null, mechanism: null, ...over,
});
const cycle: DepartmentCycle = { id: 'c1', name: 'Annual 2026', periodEnd: '2026-12-31', people: 4, finalized: 2 };

function page(rows: DepartmentViewRow[], cycles: DepartmentCycle[] = [cycle]) {
  return render(<NextIntlClientProvider locale="en" messages={en}><DepartmentViewScreen cycles={cycles} cycle={cycles[0]} rows={departmentForest(rows)} /></NextIntlClientProvider>);
}
const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((out, [k, x]) => out.replace(`{${k}}`, String(x)), s);

// Four people: two finalized (ME on mechanism A, OU on mechanism B), two pending. Ben reports to Ann.
const rows = [
  person({ employmentId: 'ann', fullName: 'Ann', direct: true, finalized: true, overallBand: 'ME', overallScore: 3.125, mechanism: 'A' }),
  person({ employmentId: 'ben', fullName: 'Ben', parentEmploymentId: 'ann', direct: false, department: null, jobTitle: null }),
  person({ employmentId: 'cat', fullName: 'Cat', direct: true, finalized: true, overallBand: 'OU', overallScore: 112.35, mechanism: 'B' }),
  person({ employmentId: 'dan', fullName: 'Dan', direct: false }),
];

describe('HOD department view screen', () => {
  it('renders the header, the five spread bars over finalized people only, the count, and the five columns in order', () => {
    page(rows);
    expect(screen.getByRole('heading', { level: 1, name: t.title })).toBeTruthy();
    expect(screen.getByText(fill(t.description, { cycle: 'Annual 2026' }))).toBeTruthy();
    const spread = screen.getByRole('region', { name: t.spreadTitle });
    const bars = spread.querySelectorAll('li[data-band]');
    expect([...bars].map((b) => b.getAttribute('data-band'))).toEqual(['UA', 'BE', 'ME', 'AE', 'OU']);
    const text = (band: string) => spread.querySelector(`li[data-band="${band}"]`)!.textContent;
    // Base 2 (finalized), not 4 (population): ME and OU are 50% each.
    expect(text('ME')).toContain(fill(t.spreadRow, { count: 1, pct: '50%' }));
    expect(text('OU')).toContain(fill(t.spreadRow, { count: 1, pct: '50%' }));
    expect(text('UA')).toContain(fill(t.spreadRow, { count: 0, pct: '0%' }));
    expect((spread.querySelector('li[data-band="ME"] span[aria-hidden] span') as HTMLElement).style.width).toBe('50%');
    expect(within(spread).getByText(fill(t.finalizedCount, { finalized: 2, total: 4 }))).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([t.columns.name, t.columns.department, t.columns.jobTitle, t.columns.relationship, t.columns.overall]);
  });

  it('orders rows as the forest, shows Direct/Indirect chips, the overall pill when finalized and Pending otherwise', () => {
    page(rows);
    const body = screen.getAllByRole('row').slice(1);
    expect(body.map((r) => r.querySelector('td')!.textContent)).toEqual(['Ann', 'Ben', 'Cat', 'Dan']);
    const cells = (name: string) => [...body.find((r) => r.querySelector('td')!.textContent === name)!.querySelectorAll('td')].map((c) => c.textContent);
    expect(cells('Ann')).toEqual(['Ann', 'Finance', 'Executive', t.relationship.direct, fill(t.overall, { score: '3.12', band: t.bands.ME })]);
    expect(cells('Ben')).toEqual(['Ben', '-', '-', t.relationship.indirect, t.pending]);
    expect(cells('Cat')[4]).toBe(fill(t.overall, { score: '112.3%', band: t.bands.OU }));
    expect(screen.getAllByText(t.pending)).toHaveLength(2);
  });

  it('offers no write control: no form, no button, no server action; only the search box is interactive', () => {
    page(rows);
    expect(document.querySelectorAll('form')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
  });

  it('filters on the whole row text and shows the no-match row', () => {
    page(rows);
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'indirect' } });
    expect(screen.getAllByRole('row').slice(1).map((r) => r.querySelector('td')!.textContent)).toEqual(['Ben', 'Dan']);
    fireEvent.change(search, { target: { value: 'pending' } });
    expect(screen.getAllByRole('row').slice(1).map((r) => r.querySelector('td')!.textContent)).toEqual(['Ben', 'Dan']);
    fireEvent.change(search, { target: { value: 'nobody here' } });
    expect(screen.getByText(t.noMatch)).toBeTruthy();
  });

  it('lists the cycles as links only when more than one is offered', () => {
    page(rows, [cycle, { ...cycle, id: 'c2', name: 'Mid-year 2026' }]);
    const nav = screen.getByRole('navigation', { name: t.cycle });
    expect(within(nav).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])).toEqual([
      ['Annual 2026', '/performance/department?cycle=c1', 'page'], ['Mid-year 2026', '/performance/department?cycle=c2', null]]);
  });
});

describe('HOD department view model', () => {
  it('builds the source forest: roots by name, children depth-first by name; a manager loop with no root is not listed', () => {
    const tree = departmentForest([
      person({ employmentId: 'z', fullName: 'Zed' }),
      person({ employmentId: 'm', fullName: 'Mia', parentEmploymentId: 'z' }),
      person({ employmentId: 'b', fullName: 'Bob', parentEmploymentId: 'z' }),
      person({ employmentId: 'k', fullName: 'Kit', parentEmploymentId: 'b' }),
      person({ employmentId: 'a', fullName: 'Amy', parentEmploymentId: 'outside' }),
      person({ employmentId: 'l1', fullName: 'Loop one', parentEmploymentId: 'l2' }),
      person({ employmentId: 'l2', fullName: 'Loop two', parentEmploymentId: 'l1' }),
    ]);
    expect(tree.map((r) => [r.fullName, r.depth])).toEqual([['Amy', 0], ['Zed', 0], ['Bob', 1], ['Kit', 2], ['Mia', 1]]);
  });

  it('counts the spread over finalized people only and the total over everyone listed', () => {
    const s = departmentSpread([...rows, person({ employmentId: 'e', fullName: 'Eve', finalized: false, overallBand: 'UA' })]);
    expect(s.counts).toEqual({ UA: 0, BE: 0, ME: 1, AE: 0, OU: 1 });
    expect([s.finalized, s.total]).toEqual([2, 5]);
    expect(departmentSpread([]).pct.ME).toBe(0);
  });

  it('formats like the source: two decimals (A), one decimal and a percent sign (B), whole spread percentages, halves to even', () => {
    expect(formatOverallScore(3.125, 'A')).toBe('3.12');
    expect(formatOverallScore(2.5, 'A')).toBe('2.50');
    expect(formatOverallScore(98.25, 'B')).toBe('98.2%');
    expect(formatSpreadPct(12.5)).toBe('12%');
    expect(formatSpreadPct(37.5)).toBe('38%');
    expect(formatSpreadPct(100 / 3)).toBe('33%');
    expect(fixedHalfEven(0.5, 0)).toBe('0');
  });

  it('shows the requested cycle when offered, else the first offered', () => {
    const offered = [cycle, { ...cycle, id: 'c2' }];
    expect(pickDepartmentCycle(offered, 'c2')?.id).toBe('c2');
    expect(pickDepartmentCycle(offered, 'not-mine')?.id).toBe('c1');
    expect(pickDepartmentCycle([], 'c1')).toBeNull();
  });
});
