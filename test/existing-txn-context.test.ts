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
import { describe, expect, it } from 'vitest';
import {
  buildTxnPanel,
  txnStatusOf,
  type StrandedInputRow,
  type TxnPanelInputRow,
} from '../app/payroll/transactions/individual/existing-context';

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
