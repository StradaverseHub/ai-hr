/**
 * 44129979 — the Individual Transaction screen's right panel: the employee's existing one-off
 * transactions, itemised, with the only two statuses the ledger can support.
 *
 * This replaces ec845c7d's summary-only derivation, which counted and totalled an employee's month
 * without ever showing the entries behind the figure. Three things can go wrong in the new derivation
 * and all three are here:
 *
 *   1. THE STATUS RULE. `payroll_individual_txn` has no status column. Paid / not-yet-paid is derived
 *      from the owning batch alone, and the direction of the failure matters: showing an unpaid row as
 *      Processed tells an operator someone has been paid when they have not. So the tests pin the
 *      unknown/absent cases to `pending`, not merely "some status".
 *   2. THE ARITHMETIC. Totals are summed in CENTS. Adding the decimal strings as floats drifts on
 *      exactly the four-figure bonuses this panel exists to make reviewable.
 *   3. THE STRANDED FILTER. d0d2c9d1's read returns ALL unattached money, deliberately including the
 *      months where nothing is wrong yet. The panel must warn about the fault subset only — warning
 *      about the designed pre-run entry flow is how a warning gets ignored.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTxnPanel,
  txnStatusOf,
  type StrandedInputRow,
  type TxnPanelInputRow,
} from '../app/payroll/transactions/individual/existing-context';
import { INDIVIDUAL_TXN_STATUS_FILTERS } from '../core/payroll-view';

// 510f4bd1 — the DEFAULT row is a FRESH one: keyed before its payslip was worked out. Every pre-existing
// expectation in this file was written when a processed row could only mean "paid", so the default has to
// keep meaning that; the staleness cases below set the two instants explicitly.
const CALCULATED = '2026-08-31T09:00:00.000000';
const BEFORE_CALC = '2026-08-01T08:00:00.000000';
const AFTER_CALC = '2026-08-31T16:33:57.000000';

const row = (p: Partial<TxnPanelInputRow> & { id: string }): TxnPanelInputRow => ({
  employmentId: 'e1',
  payPeriod: '2026-08',
  txnDate: '2026-08-10',
  kind: 'earning',
  amount: '100.00',
  quantity: null,
  unit: null,
  notes: null,
  runType: null,
  runSeq: null,
  batchStatus: null,
  createdOn: '2026-08-01',
  createdBy: null,
  changedAt: BEFORE_CALC,
  payslipCalculatedAt: CALCULATED,
  batchNeedsRecalcForEmployment: false,
  ...p,
});

const grp = (p: Partial<StrandedInputRow> = {}): StrandedInputRow => ({
  payPeriod: '2026-08',
  count: 1,
  totalAmount: '0.00',
  runState: 'none',
  arrivedAfterProcessing: false,
  ...p,
});

describe('44129979 — the two statuses the ledger actually supports', () => {
  it('calls a row processed only when its batch is processed or closed', () => {
    expect(txnStatusOf('processed')).toBe('processed');
    expect(txnStatusOf('closed')).toBe('processed');
  });

  it('calls an unattached or draft-batch row pending', () => {
    // Unattached (null) is the designed pre-run entry flow; draft is a run that has not been processed.
    expect(txnStatusOf(null)).toBe('pending');
    expect(txnStatusOf('draft')).toBe('pending');
  });

  it('degrades an unrecognised batch status to pending, never to paid', () => {
    // The asymmetry is the point: this is the one place the screen could claim someone has been paid,
    // and a status this build does not know is not evidence of that.
    expect(txnStatusOf('some_future_status')).toBe('pending');
    expect(txnStatusOf(undefined)).toBe('pending');
  });

  it('offers Edit and Delete exactly where the service would accept them', () => {
    // updateIndividualTxn / deleteIndividualTxn accept unattached, draft or PROCESSED and throw
    // BatchNotDraftError otherwise. A button that always fails is worse than a disabled one.
    //
    // 49e7e0a2 MOVED `processed` FROM false TO true, DELIBERATELY. Editing a processed run is now allowed
    // because it routes through the recalculation mark rather than diverging silently; only `closed` —
    // frozen in the app and by the 0011 database triggers — is still refused. An unrecognised status stays
    // NOT editable for the same reason `txnStatusOf` degrades it to pending: absence of knowledge is not
    // permission.
    const panel = buildTxnPanel([
      row({ id: 'unattached', batchStatus: null }),
      row({ id: 'draft', batchStatus: 'draft' }),
      row({ id: 'processed', batchStatus: 'processed' }),
      row({ id: 'closed', batchStatus: 'closed' }),
      row({ id: 'future', batchStatus: 'some_future_status' }),
    ]);
    expect(panel.rows.map((r) => [r.id, r.editable])).toEqual([
      ['unattached', true],
      ['draft', true],
      ['processed', true],
      ['closed', false],
      ['future', false],
    ]);
  });

  it('flags the rows whose edit costs a recalculation, and only those', () => {
    // `status` says PAID; `recalcOnEdit` says CHANGING IT MAKES A PROCESSED RUN STALE. They used to be the
    // same question — a paid row was a frozen row — and they are not any more. A closed row is paid and is
    // not recalculable, so it must not claim to be.
    const panel = buildTxnPanel([
      row({ id: 'unattached', batchStatus: null }),
      row({ id: 'draft', batchStatus: 'draft' }),
      row({ id: 'processed', batchStatus: 'processed' }),
      row({ id: 'closed', batchStatus: 'closed' }),
    ]);
    expect(panel.rows.map((r) => [r.id, r.status, r.recalcOnEdit])).toEqual([
      ['unattached', 'pending', false],
      ['draft', 'pending', false],
      ['processed', 'processed', true],
      ['closed', 'processed', false],
    ]);
  });

  it('separates "on a run" from "waiting for one" without adding a third status', () => {
    // Both are `pending`; `attached` is the qualifier the screen uses to word the badge, not a status.
    const panel = buildTxnPanel([row({ id: 'a', batchStatus: null }), row({ id: 'b', batchStatus: 'draft' })]);
    expect(panel.rows.map((r) => [r.status, r.attached])).toEqual([
      ['pending', false],
      ['pending', true],
    ]);
  });
});

/**
 * 510f4bd1 — THE TRUTH TABLE FOR THE THIRD STATUS.
 *
 * `Processed` has to mean exactly one thing: this amount is in the employee's LATEST payslip. Nothing new
 * is detected to make that true — 49e7e0a2's mark, `closeBatch`'s refusal and the Reprocess screen's
 * pre-tick already existed; this only reads them. So what these cases pin is the DERIVATION, in both
 * directions, because both directions are wrong in a way an operator cannot see:
 *
 *   - calling a superseded row `Processed` tells them money is in a payslip that it is not;
 *   - calling a fresh row `Pending reprocessing` sends them to recalculate a run that is already correct.
 */
describe('510f4bd1 — Processed means "in the latest payslip", and nothing else does', () => {
  const facts = (changedAt: string | null, payslipCalculatedAt: string | null) => ({ changedAt, payslipCalculatedAt });

  it('leaves an untouched row on a processed run Processed', () => {
    // Request case 1: processed, not since changed. The overtime line in the reporter's own August run.
    expect(txnStatusOf('processed', facts(BEFORE_CALC, CALCULATED))).toBe('processed');
  });

  it('flags a row EDITED after the run was calculated', () => {
    // Request case 2: Bonus 500 → 800 on a processed run. `updated_at` is stamped by the edit.
    expect(txnStatusOf('processed', facts(AFTER_CALC, CALCULATED))).toBe('reprocessRequired');
  });

  it('flags a row ADDED after the run was calculated — THE ROW THE coalesce EXISTS FOR', () => {
    // Request case 3, and the one live stale row on production (X000001's director fee, created 16:33:57
    // against a payslip created 16:30:56). `payroll_individual_txn.updated_at` is NULL on a row that has
    // never been edited, so `changedAt` is coalesce(updated_at, created_at) — comparing updated_at alone
    // would call this row fresh, which is the exact defect the request reports.
    const neverEdited = row({ id: 'added', batchStatus: 'processed', changedAt: AFTER_CALC, payslipCalculatedAt: CALCULATED });
    expect(neverEdited.changedAt, 'the caller must have coalesced already — this module never sees a null').toBe(AFTER_CALC);
    expect(buildTxnPanel([neverEdited]).rows[0].status).toBe('reprocessRequired');
  });

  it('flags a row on a processed run when the employee has NO payslip on it at all', () => {
    // Never calculated for this person, so it cannot be "in the latest calculation". Null is not the same
    // as absent: an omitted fact makes no claim (below), a null one is evidence.
    expect(txnStatusOf('processed', facts(BEFORE_CALC, null))).toBe('reprocessRequired');
  });

  it('makes NO claim when the payslip fact was not supplied at all', () => {
    // Every caller supplies it; a bare call (or an older one) must not be upgraded to the worst case.
    expect(txnStatusOf('processed')).toBe('processed');
    expect(txnStatusOf('closed')).toBe('processed');
  });

  it('never flags a draft, unattached or CLOSED run', () => {
    // Draft recalculates by being generated. Unattached has no run. Closed cannot be written at all —
    // and `closeBatch` refuses to close a run that is still marked, so closed can only mean settled.
    expect(txnStatusOf('draft', facts(AFTER_CALC, null))).toBe('pending');
    expect(txnStatusOf(null, facts(AFTER_CALC, null))).toBe('pending');
    expect(txnStatusOf('closed', facts(AFTER_CALC, CALCULATED))).toBe('processed');
    expect(txnStatusOf('closed', facts(AFTER_CALC, null))).toBe('processed');
  });

  it('does not flag an unrecognised batch status either — the asymmetry is preserved', () => {
    expect(txnStatusOf('some_future_status', facts(AFTER_CALC, null))).toBe('pending');
  });

  it('settles back to Processed after a reprocess, with nothing set by hand', () => {
    // Selective reprocess DELETEs and re-INSERTs the payslip, so `payslip.created_at` moves PAST the row's
    // change instant. Request case 6, and it is why no status column is needed.
    const stale = row({ id: 'x', batchStatus: 'processed', changedAt: AFTER_CALC, payslipCalculatedAt: CALCULATED });
    expect(buildTxnPanel([stale]).rows[0].status).toBe('reprocessRequired');
    const afterReprocess = { ...stale, payslipCalculatedAt: '2026-08-31T16:34:20.000000' };
    expect(buildTxnPanel([afterReprocess]).rows[0].status).toBe('processed');
  });

  it('leaves every row Processed when the mark came from somewhere other than a transaction', () => {
    // The DELIBERATE, CORRECT disagreement: an attendance-driven recompute (or a DELETE, which leaves no
    // row to label at all) marks the EMPLOYMENT without touching any row. The employee line reads Reprocess
    // required; the badges do not, because the badges are about the transactions. Anyone "fixing" this
    // would be marking lines that are genuinely in the payslip.
    const panel = buildTxnPanel([
      row({ id: 'a', batchStatus: 'processed', batchNeedsRecalcForEmployment: true }),
      row({ id: 'b', batchStatus: 'processed', batchNeedsRecalcForEmployment: true }),
    ]);
    expect(panel.rows.map((r) => r.status)).toEqual(['processed', 'processed']);
    expect(panel.rows.every((r) => r.batchNeedsRecalcForEmployment), 'the employee-level fact rides on').toBe(true);
    expect(panel.totals.reprocessCount).toBe(0);
  });

  it('keeps Pending reprocessing a THIRD bucket that still sums to the whole', () => {
    // buildTxnPanel's loop was `if (pending) … else processed`. Left that way, every stale row would have
    // been counted as PAID — the strip would have contradicted the badge beside it.
    const panel = buildTxnPanel([
      row({ id: 'p', amount: '10.00', batchStatus: 'draft' }),
      row({ id: 'd', amount: '20.00', batchStatus: 'processed' }),
      row({ id: 's', amount: '500.00', batchStatus: 'processed', changedAt: AFTER_CALC }),
      row({ id: 'n', amount: '30.00', batchStatus: 'processed', payslipCalculatedAt: null }),
    ]);
    expect(panel.totals).toEqual({
      count: 4,
      total: '560.00',
      pendingCount: 1,
      pendingTotal: '10.00',
      processedCount: 1,
      processedTotal: '20.00',
      reprocessCount: 2,
      reprocessTotal: '530.00',
    });
    // The three buckets partition the whole — no row counted twice, none dropped.
    expect(panel.totals.pendingCount + panel.totals.processedCount + panel.totals.reprocessCount).toBe(
      panel.totals.count,
    );
    const cents = (v: string) => Math.round(Number(v) * 100);
    expect(cents(panel.totals.pendingTotal) + cents(panel.totals.processedTotal) + cents(panel.totals.reprocessTotal)).toBe(
      cents(panel.totals.total),
    );
  });

  it('keeps a stale row EDITABLE — Pending reprocessing is a correction invitation, not a lock', () => {
    // Request's Payroll Closing Control: on a processed-but-not-closed run edit/add/delete stay allowed.
    const panel = buildTxnPanel([row({ id: 's', batchStatus: 'processed', changedAt: AFTER_CALC })]);
    expect(panel.rows[0].editable).toBe(true);
    expect(panel.rows[0].recalcOnEdit).toBe(true);
  });
});

describe('510f4bd1 — the History filter whitelists cannot drift apart, because a mismatch fails OPEN', () => {
  it('the screen and its CSV export offer exactly the statuses the read accepts', () => {
    // cleanBatchStatus returns undefined for an unrecognised value, which DROPS the filter rather than
    // narrowing to nothing: a value offered on screen but missing from the read silently shows EVERY row.
    // Read off the sources, because the two whitelists are the thing that can drift.
    const viewSrc = readFileSync(join(__dirname, '..', 'app', 'payroll', 'transaction-view', 'page.tsx'), 'utf8');
    const exportSrc = readFileSync(
      join(__dirname, '..', 'app', 'payroll', 'transaction-view', 'export', 'route.ts'),
      'utf8',
    );
    expect(INDIVIDUAL_TXN_STATUS_FILTERS).toContain('reprocess');
    expect(viewSrc, 'the screen must take its whitelist from the read, not restate it').toContain(
      'const TXN_STATUSES = INDIVIDUAL_TXN_STATUS_FILTERS',
    );
    expect(exportSrc, 'and so must the CSV route, or the download is a different row set').toContain(
      'const TXN_STATUSES = INDIVIDUAL_TXN_STATUS_FILTERS',
    );
  });

  it('every offered filter value has a label in every catalogue', () => {
    // The select renders `payroll.list.status.<value>`; a value with no key paints the raw key path while
    // the route still returns 200, which no coverage guard sees.
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const messages = JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${locale}.json`), 'utf8'));
      for (const value of INDIVIDUAL_TXN_STATUS_FILTERS) {
        expect(messages.payroll.list.status[value], `${locale}: payroll.list.status.${value}`).toBeTruthy();
      }
      for (const key of [
        'statusReprocessRequired',
        'totalReprocess',
        'employeeReprocessRequired',
        'employeeReprocessLink',
        'stalePendingHint',
        'employeeReprocessHint',
      ]) {
        expect(
          messages.payroll.transactions.individual[key],
          `${locale}: payroll.transactions.individual.${key}`,
        ).toBeTruthy();
      }
    }
  });
});

describe('44129979 — totals come from exactly the rows on screen', () => {
  it('splits the total into paid and not-yet-paid', () => {
    const panel = buildTxnPanel([
      row({ id: 'a', amount: '500.00', batchStatus: null }),
      row({ id: 'b', amount: '250.50', batchStatus: 'draft' }),
      row({ id: 'c', amount: '1000.00', batchStatus: 'processed' }),
    ]);
    expect(panel.totals).toEqual({
      count: 3,
      total: '1750.50',
      pendingCount: 2,
      pendingTotal: '750.50',
      processedCount: 1,
      processedTotal: '1000.00',
      reprocessCount: 0,
      reprocessTotal: '0.00',
    });
  });

  it('adds a long column of amounts to the exact figure', () => {
    // NOT a float-drift test, and the comment says so deliberately: the ledger stores numeric(12,2),
    // and a float sum of two-decimal strings prints the same toFixed(2) — searched over random 2..6-row
    // combinations without finding a divergence. What this pins is the summation itself (every row
    // counted once, into the right bucket), which is what actually regresses.
    const amounts = ['0.10', '0.20', '1234.55', '99.99', '0.01', '4500.00', '17.35'];
    const panel = buildTxnPanel(amounts.map((amount, i) => row({ id: `r${i}`, amount })));
    expect(panel.totals.count).toBe(7);
    expect(panel.totals.total).toBe('5852.20');
    expect(panel.totals.pendingTotal).toBe('5852.20');
  });

  it('reports zeroes rather than nothing when the employee has no transactions', () => {
    // The panel renders the strip unconditionally; a missing total would make it print undefined.
    expect(buildTxnPanel([]).totals).toEqual({
      count: 0,
      total: '0.00',
      pendingCount: 0,
      pendingTotal: '0.00',
      processedCount: 0,
      processedTotal: '0.00',
      reprocessCount: 0,
      reprocessTotal: '0.00',
    });
  });

  it('treats an unreadable amount as zero instead of poisoning the whole total', () => {
    const panel = buildTxnPanel([row({ id: 'a', amount: 'not-a-number' }), row({ id: 'b', amount: '10.00' })]);
    expect(panel.totals.total).toBe('10.00');
  });
});

describe('44129979 — the stranded warning is the fault subset only', () => {
  it('warns when the month’s regular run is already processed or closed', () => {
    for (const runState of ['processed', 'closed'] as const) {
      const panel = buildTxnPanel([], [grp({ runState, count: 2, totalAmount: '1500.00' })]);
      expect(panel.stranded, `runState ${runState}`).toEqual([{ payPeriod: '2026-08', count: 2, total: '1500.00' }]);
    }
  });

  it('warns when the rows were keyed after the run was processed', () => {
    const panel = buildTxnPanel([], [grp({ runState: 'draft', arrivedAfterProcessing: true, totalAmount: '80.00' })]);
    expect(panel.stranded).toHaveLength(1);
  });

  it('stays silent while the money is simply waiting for a run', () => {
    // A month with no run yet, or a draft one, is the DESIGNED pre-run entry flow (f1564110 Phase 2).
    // Flagging it would train the operator to ignore the flag that matters.
    expect(buildTxnPanel([], [grp({ runState: 'none' })]).stranded).toEqual([]);
    expect(buildTxnPanel([], [grp({ runState: 'draft' })]).stranded).toEqual([]);
  });

  it('adds up several stranded groups in the same month and keeps months newest first', () => {
    const panel = buildTxnPanel(
      [],
      [
        grp({ payPeriod: '2026-06', runState: 'closed', count: 1, totalAmount: '50.00' }),
        grp({ payPeriod: '2026-08', runState: 'processed', count: 2, totalAmount: '1000.00' }),
        grp({ payPeriod: '2026-08', runState: 'closed', count: 3, totalAmount: '2350.25' }),
      ],
    );
    expect(panel.stranded).toEqual([
      { payPeriod: '2026-08', count: 5, total: '3350.25' },
      { payPeriod: '2026-06', count: 1, total: '50.00' },
    ]);
  });

  it('does not stand in for the row statuses — a processed row is not stranded money', () => {
    // The two answer different questions and the screen shows them in different places. A panel whose
    // rows are all paid, with no unattached money, must carry no warning at all.
    const panel = buildTxnPanel([row({ id: 'a', batchStatus: 'processed' })], []);
    expect(panel.stranded).toEqual([]);
    expect(panel.totals.processedCount).toBe(1);
  });
});
