/**
 * 1372d169 — Payroll → Transaction View is full width on EVERY tab, and the identity/money columns
 * stop wrapping.
 *
 * WHY THIS FILE EXISTS AT ALL, and why it names the round-trip. r179 removed the left-hand employee
 * rail from the Transaction Detail tab to give the table more room; the reporter contested it and
 * 98e69987 rev 2 put it back on 2026-08-11. This item is NOT that trade-off and must never be built as
 * that trade-off: the cause was one expression in app/payroll/transaction-view/page.tsx that capped four
 * of the five tabs at `max-w-6xl` (1152px) while the fifth — the ONLY one that has ever had an employee
 * rail — was already full width. So the fix widens four tabs and touches no rail at all. Assertion (1)
 * pins the width rule; assertion (2) pins that the rail is still mounted, so a future "full width"
 * change cannot reach for it a third time.
 *
 * (3) is the no-wrap half, asserted on RENDERED MARKUP rather than on source: the class must survive
 * whatever cn()/template composition the cell is written with. jsdom applies no CSS and computes no
 * layout, so this cannot prove a pixel — what it proves is that the cell that wrapped on production
 * carries the class that stops it. The <th> captions are deliberately left OUT (TOTAL DEDUCTIONS
 * legitimately uses two header lines and nowrap truncates it), and that exclusion is asserted too.
 *
 * NOT COVERED, deliberately: the sticky header from the same request. `main` is the page scroller and
 * each table sits in an `overflow-x-auto` div, which computes to a scroll container on BOTH axes — a
 * `sticky top-0` thead would stick to something that never scrolls vertically. Delivering it means
 * choosing an inner scroll region or dropping horizontal scroll; both are real decisions and it is
 * recorded on the board as its own follow-up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import type { IndividualTxnViewRow, ProcessedPayslipViewRow, UnattachedGroupRow } from '../core/payroll-view';
import { IndividualTxnTable } from '../app/payroll/transaction-view/individual-table';
import { OutstandingTable } from '../app/payroll/transaction-view/outstanding-table';
import { HistoryTable } from '../app/payroll/transaction-view/history-table';

// The address bar, stubbed — these tables read ?page/?size through useClientPageQuery and nothing here
// navigates. Same shape as test/client-pager.dom.test.tsx.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE = 'app/payroll/transaction-view/page.tsx';

// ─────────────────────────── 1. the width rule ───────────────────────────

describe('1372d169 · Transaction View has one width rule for all five tabs', () => {
  /** Every string-literal / template-literal className value in a source file. */
  const classNames = (src: string) =>
    [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);

  it('has no centered page-level width cap left anywhere in the page', () => {
    // The same predicate test/leave-config-full-width.test.ts uses: `mx-auto` AND a `max-w-<n>xl` in ONE
    // class string is a page-level cap. Inner reading measures without mx-auto (the expanded History
    // breakdown's max-w-3xl) are legitimate and out of reach of this rule by construction.
    const offending = classNames(read(PAGE)).filter(
      (c) => /\bmx-auto\b/.test(c) && /\bmax-w-\d*xl\b/.test(c),
    );
    expect(offending, `${PAGE} re-introduces a page-level width cap: ${offending.join(' | ')}`).toEqual([]);
  });

  it('uses pageWideCls unconditionally — the per-tab conditional is gone', () => {
    const src = read(PAGE);
    expect(src).toContain('<div className={pageWideCls}>');
    // The exact expression the reporter came back about. If it ever returns, four tabs silently go
    // narrow again and the screen stops matching every other payroll screen.
    expect(src).not.toContain("tab === 'grid' ? pageWideCls");
    // Scanned over className VALUES, not raw source — the file's own comment names the cap it removed,
    // and a comment mentioning `max-w-6xl` is documentation, not a width rule.
    expect(classNames(src).filter((c) => c.includes('max-w-6xl'))).toEqual([]);
  });
});

// ─────────────────────── 2. the employee rail SURVIVES ───────────────────────

describe('1372d169 · the Transaction Detail employee rail is untouched', () => {
  it('still mounts CollapsibleEmployeePanel on the grid tab', () => {
    const src = read(PAGE);
    // r179 removed this and the reporter contested; 98e69987 rev 2 restored it. A width change must not
    // be the third reversal. Both the import and the mount are pinned so neither can be dropped quietly.
    expect(src).toContain("from '@/components/collapsible-employee-panel'");
    expect(src).toContain('<CollapsibleEmployeePanel');
    expect(src).toContain('<EmployeeScopePanel');
    // And it is still the GRID tab that carries it — i.e. the rail did not move onto a tab that never
    // had one as a side effect of the widening.
    const gridBranch = src.slice(src.indexOf("{tab === 'grid' && ("));
    expect(gridBranch).toContain('<CollapsibleEmployeePanel');
  });
});

// ─────────────────────── 3. the cells that wrapped, don't ───────────────────────

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    {ui}
  </NextIntlClientProvider>
);

/** The <td> in the first body row under the header whose caption is `caption`. */
function bodyCell(caption: string): HTMLTableCellElement {
  const table = screen.getByRole('table');
  const heads = [...table.querySelectorAll('thead th')];
  const idx = heads.findIndex((th) => (th.textContent ?? '').trim().toLowerCase().startsWith(caption.toLowerCase()));
  expect(idx, `no header starting "${caption}" in [${heads.map((h) => h.textContent?.trim()).join(' | ')}]`).toBeGreaterThanOrEqual(0);
  const cells = [...table.querySelectorAll('tbody tr')][0].querySelectorAll('td');
  return cells[idx] as HTMLTableCellElement;
}

// Long enough to have wrapped at 1152px — these are the shapes measured on production
// (NURUL ALIAH BINTI ACHIN at "Fiamma Holdings Berhad (Chin Hin Property)").
const LONG_NAME = 'NURUL ALIAH BINTI ACHIN';
const LONG_COMPANY = 'Fiamma Holdings Berhad (Chin Hin Property)';

const individualRow: IndividualTxnViewRow = {
  id: 'txn-1',
  employmentId: 'emp-1',
  employeeName: LONG_NAME,
  employeeCode: 'X000001',
  companyId: 'co-1',
  company: LONG_COMPANY,
  payPeriod: '2026-08',
  runType: 'regular',
  runSeq: 1,
  batchStatus: 'processed',
  kind: 'earning',
  // 4e403268 added these to the shared projection; they play no part in the width guard.
  componentId: null,
  componentCode: null,
  componentName: null,
  source: null,
  txnDate: '2026-08-01',
  amount: '584.13',
  quantity: '15.00',
  unit: 'hours',
  notes: 'Overtime worked on the Chin Hin Property site over the August long weekend, approved by the PM',
  createdOn: '2026-08-10',
  createdById: null,
  createdBy: 'Admin User',
  changedAt: '2026-08-10T00:00:00.000Z',
  payslipCalculatedAt: '2026-08-11T00:00:00.000Z',
  batchNeedsRecalcForEmployment: false,
  reprocessRequired: false,
};

const outstandingRow: UnattachedGroupRow = {
  employmentId: 'emp-1',
  employeeName: LONG_NAME,
  employeeCode: 'X000001',
  companyId: 'co-1',
  company: LONG_COMPANY,
  currency: 'MYR',
  payPeriod: '2026-08',
  count: 3,
  totalAmount: '1200.00',
  oldestTxnDate: '2026-08-01',
  runState: 'processed',
  arrivedAfterProcessing: true,
  // c11e81aa — this group named no Pay Cycle, which is every row on production today.
  intendedCycleId: null,
  intendedCycleName: null,
  intendedRunType: null,
};

const historyRow: ProcessedPayslipViewRow = {
  id: 'slip-1',
  employmentId: 'emp-1',
  employeeName: LONG_NAME,
  employeeCode: 'X000001',
  companyId: 'co-1',
  company: LONG_COMPANY,
  currency: 'MYR',
  payPeriod: '2026-08',
  runType: 'regular',
  runSeq: 1,
  batchStatus: 'processed',
  releasedAt: null,
  version: 1,
  basic: '5000.00',
  allowance: '400.00',
  overtime: '0.00',
  bonus: '584.13',
  gross: '5984.13',
  statutory: {},
  totalDeductions: '700.00',
  net: '5284.13',
};

describe('1372d169 · identity columns render on one line', () => {
  it('Individual tab — employee and company are nowrap, notes is truncated instead', () => {
    render(wrap(<IndividualTxnTable rows={[individualRow]} />));
    expect(bodyCell('Employee').className).toContain('whitespace-nowrap');
    expect(bodyCell('Company').className).toContain('whitespace-nowrap');
    // Free text gets a cap + truncate rather than nowrap: nowrapping a long note pushes every other
    // column off the screen, which is the opposite of what the reporter asked for.
    const notes = bodyCell('Notes');
    expect(notes.className).not.toContain('whitespace-nowrap');
    expect(notes.querySelector('span')?.className).toContain('truncate');
  });

  it('Outstanding tab — employee and company are nowrap', () => {
    render(wrap(<OutstandingTable rows={[outstandingRow]} />));
    expect(bodyCell('Employee').className).toContain('whitespace-nowrap');
    expect(bodyCell('Company').className).toContain('whitespace-nowrap');
  });

  it('History tab — employee and company are nowrap on the widest table (13 columns)', () => {
    render(wrap(<HistoryTable rows={[historyRow]} hrdfRegisteredCompanyIds={[]} />));
    expect(bodyCell('Employee').className).toContain('whitespace-nowrap');
    expect(bodyCell('Company').className).toContain('whitespace-nowrap');
  });

  it('leaves the HEADER captions wrappable — TOTAL DEDUCTIONS needs two lines', () => {
    render(wrap(<HistoryTable rows={[historyRow]} hrdfRegisteredCompanyIds={[]} />));
    const heads = [...screen.getByRole('table').querySelectorAll('thead th')];
    const offending = heads.filter((th) => th.className.includes('whitespace-nowrap'));
    expect(
      offending.map((th) => th.textContent?.trim()),
      'nowrap on a <th> truncates the two-line TOTAL DEDUCTIONS caption',
    ).toEqual([]);
  });
});

describe('1372d169 · the Fixed tab table (inline in page.tsx) matches', () => {
  it('nowraps employee, company and pay item', () => {
    // The Fixed tab renders inside the server component, so it is asserted at source rather than in
    // jsdom. The three cells named here are the ones measured wrapping on production.
    const src = read(PAGE);
    // Sliced between the two SECTION markers, not on `{tab === 'fixed' && (` — that expression also opens
    // the tab's filter fields higher up the file, and slicing there would read the filter row instead.
    const from = src.indexOf('── 1. Fixed Transaction View ──');
    const to = src.indexOf('── 2. Individual Transaction View');
    expect(from, 'the Fixed Transaction View section marker moved').toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const fixedTable = src.slice(from, to);
    expect(fixedTable).toContain('<td className="whitespace-nowrap px-4 py-2.5 font-medium">');
    expect(fixedTable).toContain('<td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{r.company}</td>');
    // The pay-item cell (code + description).
    expect(fixedTable.match(/<td className="whitespace-nowrap px-4 py-2\.5">/)).not.toBeNull();
  });
});
