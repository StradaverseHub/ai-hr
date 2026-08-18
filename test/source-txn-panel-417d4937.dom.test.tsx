/**
 * 417d4937 request 10 — WHERE EVERY RECORDED ITEM CAME FROM, PROVED BY RENDERING.
 *
 * THE REPORTER'S ACTUAL DIFFICULTY. On the SpaceX 2026-08 run there IS a real Director Fee transaction
 * recorded against that employee, so the description was not a leftover label from another pay item —
 * but the screen gave them no way to establish that. Recorded items shows a code, a description and an
 * amount and says nothing about where the line came from, so settling the question took a report and a
 * conversation. Alongside it, that transaction was not marked as paid in the ledger even though the
 * payslip prints it, which is the mismatch the item is named after.
 *
 * TWO POPULATIONS, NEVER A JOIN. Amounts and pay items can repeat inside one run and nothing links a
 * record line back to the `payroll_individual_txn.id` that produced it, so the block lists the ledger
 * rows BESIDE Recorded items and lets the reader match them. A join invented from (code, amount) would
 * be right most of the time and confidently wrong the rest — on the one screen whose purpose is
 * verification, that is worse than the lump it replaces. The last case below pins that no total is
 * printed either: these rows restate money already counted in the figures above them.
 *
 * Rendered rather than asserted on the read, for the reason this pair keeps being caught by: three
 * previous attempts were correct derivations feeding a renderer that printed something else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { SourceTxnBlock } from '../app/payroll/transaction-view/source-txn-block';
import type { PayslipSourceTxnRow } from '../core/payroll-view';

const THIS_RUN = '00000000-0000-0000-0000-0000000000b1';
const OTHER_RUN = '00000000-0000-0000-0000-0000000000b2';

const txn = (over: Partial<PayslipSourceTxnRow> = {}): PayslipSourceTxnRow =>
  ({
    id: '00000000-0000-0000-0000-0000000000t1',
    batchId: THIS_RUN,
    employmentId: '00000000-0000-0000-0000-0000000000e1',
    txnDate: '2026-08-15',
    kind: 'earning',
    componentCode: 'A0020',
    componentName: 'DIRECTOR FEE',
    amount: '400.00',
    source: 'manual',
    notes: 'August director fee',
    consumedBatchId: THIS_RUN,
    consumedByThisRun: true,
    ...over,
  }) as PayslipSourceTxnRow;

const draw = (rows: PayslipSourceTxnRow[]) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SourceTxnBlock rows={rows} />
    </NextIntlClientProvider>,
  );

describe('417d4937 — the provenance block beneath Recorded items', () => {
  it('names the transaction: date, pay item, how it was entered, and the amount', () => {
    draw([txn()]);
    expect(screen.getByText('Where these came from')).toBeInTheDocument();
    expect(screen.getByText('2026-08-15')).toBeInTheDocument();
    expect(screen.getByText('A0020 · DIRECTOR FEE')).toBeInTheDocument();
    expect(screen.getByText('RM 400.00')).toBeInTheDocument();
    expect(screen.getByText('August director fee')).toBeInTheDocument();
    expect(screen.getByText(/Earning · Manual · Paid by this run/)).toBeInTheDocument();
  });

  it('states which run paid it — the marker the item is named after', () => {
    // The reporter's own case: the payslip prints the line, and the ledger says nothing marked it paid.
    draw([txn({ consumedBatchId: null, consumedByThisRun: false })]);
    expect(screen.getByText(/Not marked as paid/)).toBeInTheDocument();

    screen.getByText(/Not marked as paid/); // sanity: only one block rendered
    draw([txn({ id: 'x', consumedBatchId: OTHER_RUN, consumedByThisRun: false })]);
    expect(screen.getByText(/Paid by another run/)).toBeInTheDocument();
  });

  it('a kind-only row (no pay item) is named by its kind rather than left blank', () => {
    draw([txn({ componentCode: null, componentName: null, kind: 'overtime', notes: null })]);
    // The item column falls back to the kind caption; it is never an empty cell on a money screen.
    expect(screen.getAllByText(/Overtime/).length).toBeGreaterThan(0);
  });

  it('renders NOTHING at all when the run has no one-off rows for this employee', () => {
    const { container } = draw([]);
    expect(container.textContent).toBe('');
  });

  it('prints no total — these rows restate money already counted above them', () => {
    draw([txn(), txn({ id: 'x2', amount: '150.00', componentCode: 'A0040', componentName: 'MEAL ALLOWANCE' })]);
    expect(screen.getByText('RM 400.00')).toBeInTheDocument();
    expect(screen.getByText('RM 150.00')).toBeInTheDocument();
    // 550.00 would be the sum. Its absence is the assertion.
    expect(screen.queryByText('RM 550.00')).toBeNull();
  });
});

/**
 * A computed `t()` key is invisible to the static i18n scan, so the two maps in the component are
 * exhaustive over their enums and every value must already exist in all six catalogues. Same convention
 * (and same failure mode) as EMPLOYER_BORNE_LABEL in history-table.tsx.
 */
describe('417d4937 — every computed caption key exists, in every locale', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'vi', 'th'] as const;
  const ROOT = path.resolve(__dirname, '..');
  const load = (loc: string) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8')) as Record<string, never>;

  it('kindLabel and sourceValue cover every ledger kind and every provenance', () => {
    for (const loc of LOCALES) {
      const ind = (load(loc) as never as { payroll: { transactions: { individual: Record<string, Record<string, string>> } } })
        .payroll.transactions.individual;
      for (const k of ['earning', 'deduction', 'overtime', 'unpaid', 'leave']) {
        expect(ind.kindLabel[k], `${loc} kindLabel.${k}`).toBeTruthy();
      }
      for (const k of ['manual', 'attendance', 'leave', 'import', 'system']) {
        expect(ind.sourceValue[k], `${loc} sourceValue.${k}`).toBeTruthy();
      }
    }
  });

  it('the block’s own five captions exist in every locale', () => {
    for (const loc of LOCALES) {
      const h = (load(loc) as never as { payroll: { transactions: { view: { history: Record<string, string> } } } })
        .payroll.transactions.view.history;
      for (const k of [
        'sourceHeading', 'sourceNote', 'sourcePaidByThisRun', 'sourcePaidByOtherRun', 'sourceNotMarkedPaid',
        'itemRemark',
      ]) {
        expect(h[k], `${loc} view.history.${k}`).toBeTruthy();
      }
    }
  });
});

/**
 * THE WIRING IS THE FIX (again). A block no screen is handed rows for renders nothing forever, and both
 * reads must stay fenced on the caller's authorised companies — the read fails closed on an empty scope,
 * and that is only true as long as the callers keep passing one.
 */
describe('417d4937 — both screens read the ledger, fenced', () => {
  const ROOT = path.resolve(__dirname, '..');
  const src = (rel: string) =>
    fs
      .readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // The employment list is the third leg of the fence, not a nicety: batch + company alone returns every
  // employee's ledger rows on every shown run, and the client table can only ever look up
  // `${batchId}:${employmentId}` — so the surplus renders nothing and ships anyway. No DOM assertion can
  // see that, which is exactly why it is pinned on the source of both callers and of the read.
  it('Transaction View → History passes the scoped company ids, the runs AND the employees on screen', () => {
    const page = src('app/payroll/transaction-view/page.tsx');
    expect(page).toContain('const historyEmploymentIds = [...new Set(shownHistoryRows.map((r) => r.employmentId))];');
    expect(page).toMatch(
      /listPayslipSourceTxns\(s, \{\s*companyIds,\s*batchIds: historyBatchIds,\s*employmentIds: historyEmploymentIds,\s*\}\)/,
    );
    expect(page).toContain('sourceTxnsByPayslip={sourceTxnsByPayslip}');
  });

  it('Individual Payslip passes the scoped company ids, its own run and its own employee', () => {
    const page = src('app/payroll/individual-payslip/page.tsx');
    expect(page).toMatch(
      /listPayslipSourceTxns\(s, \{\s*companyIds,\s*batchIds: \[row\.batchId\],\s*employmentIds: \[row\.employmentId\],\s*\}\)/,
    );
    // The narrowing is in the QUERY. A post-hoc filter on the result reads identically on screen while
    // still fetching and serialising the whole run.
    expect(page).not.toContain('(r) => r.employmentId === row.employmentId');
    expect(page).toContain('<SourceTxnBlock rows={sourceTxns} />');
  });

  it('the read itself fails closed on an empty scope, on no runs and on no employees', () => {
    const read = src('core/payroll-view.ts');
    expect(read).toMatch(
      /if \(p\.companyIds\.length === 0 \|\| p\.batchIds\.length === 0 \|\| p\.employmentIds\.length === 0\)/,
    );
    // The company fence is on the BATCH, which is where a payslip's company actually lives.
    expect(read).toContain('inArray(payrollBatch.companyId, p.companyIds),');
    expect(read).toContain('inArray(payrollIndividualTxn.employmentId, p.employmentIds),');
  });
});
