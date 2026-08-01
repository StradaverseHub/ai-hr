/**
 * ec845c7d — the Individual-Transaction wizard's "already entered / still unpaid" panel.
 *
 * The approved plan made two demands of this screen that pull against each other, and both are what
 * these tests are about:
 *
 *   1. it must SURFACE the money that was entered but never reached a payslip (production held 11 such
 *      rows worth RM23,170 when the item was raised), because a faster entry screen with no indication
 *      of it just makes it easier to key money that never gets paid;
 *   2. it must NOT invent a second definition of "unpaid" — the numbers have to be the ones the
 *      Transaction View's Outstanding tab shows, or the operator gets two answers.
 *
 * So `deriveExistingTxnContext` decides nothing about what unpaid means. It joins two existing reads by
 * employment and does the arithmetic, and the arithmetic is what can go wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveExistingTxnContext,
  type TxnAmountRow,
  type UnattachedSummaryRow,
} from '../app/payroll/transactions/individual/existing-context';

const txn = (employmentId: string, amount: string): TxnAmountRow => ({ employmentId, amount });
const grp = (p: Partial<UnattachedSummaryRow> & { employmentId: string }): UnattachedSummaryRow => ({
  count: 1,
  totalAmount: '0.00',
  runState: 'none',
  arrivedAfterProcessing: false,
  ...p,
});

describe('ec845c7d — what the employee already has for the month', () => {
  it('counts and totals only the employees being keyed', () => {
    const rows = deriveExistingTxnContext(
      ['a'],
      [txn('a', '100.00'), txn('a', '250.50'), txn('b', '9999.00')],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ employmentId: 'a', count: 2, total: '350.50' });
  });

  it('still returns a row for an employee with nothing keyed', () => {
    // The panel renders per selected person; a missing entry would make the wizard guess.
    const rows = deriveExistingTxnContext(['a', 'b'], [txn('a', '10.00')], []);
    expect(rows.map((r) => r.employmentId).sort()).toEqual(['a', 'b']);
    expect(rows.find((r) => r.employmentId === 'b')).toMatchObject({ count: 0, total: '0.00', unpaidCount: 0 });
  });

  it('sums in cents, so a long column of ordinary amounts does not drift', () => {
    // 0.1 + 0.2 arithmetic on the decimal STRINGS is the failure this guards: three of these as floats
    // give 0.30000000000000004, and the panel would print a total that disagrees with the ledger.
    const rows = deriveExistingTxnContext(['a'], [txn('a', '0.10'), txn('a', '0.20'), txn('a', '1234.55')], []);
    expect(rows[0]!.total).toBe('1234.85');
  });
});

describe('ec845c7d — the unpaid subset is d0d2c9d1’s, joined not redefined', () => {
  it('carries the unattached count and total through untouched', () => {
    const rows = deriveExistingTxnContext(
      ['a'],
      [txn('a', '500.00'), txn('a', '1500.00')],
      [grp({ employmentId: 'a', count: 1, totalAmount: '1500.00' })],
    );
    expect(rows[0]).toMatchObject({ count: 2, total: '2000.00', unpaidCount: 1, unpaidTotal: '1500.00' });
  });

  it('adds up several unattached groups for one employee', () => {
    // One employee can hold unattached rows in more than one group for the same month.
    const rows = deriveExistingTxnContext(
      ['a'],
      [],
      [
        grp({ employmentId: 'a', count: 2, totalAmount: '1000.00' }),
        grp({ employmentId: 'a', count: 3, totalAmount: '2350.25' }),
      ],
    );
    expect(rows[0]).toMatchObject({ unpaidCount: 5, unpaidTotal: '3350.25' });
  });

  it('distinguishes "not paid yet" from "the run has already gone"', () => {
    // The difference the panel colours: with no run yet the money is simply waiting; once the month's
    // run is processed or closed, or the row was keyed after processing, it has MISSED it and someone
    // has to act. Reading both the same way is what let RM23,170 sit unnoticed.
    const waiting = deriveExistingTxnContext(['a'], [], [grp({ employmentId: 'a', runState: 'none' })]);
    expect(waiting[0]!.missedTheRun).toBe(false);

    const stillDraft = deriveExistingTxnContext(['a'], [], [grp({ employmentId: 'a', runState: 'draft' })]);
    expect(stillDraft[0]!.missedTheRun).toBe(false);

    for (const runState of ['processed', 'closed'] as const) {
      const missed = deriveExistingTxnContext(['a'], [], [grp({ employmentId: 'a', runState })]);
      expect(missed[0]!.missedTheRun, `runState ${runState}`).toBe(true);
    }

    const late = deriveExistingTxnContext(
      ['a'],
      [],
      [grp({ employmentId: 'a', runState: 'draft', arrivedAfterProcessing: true })],
    );
    expect(late[0]!.missedTheRun, 'keyed after the run was processed').toBe(true);
  });

  it('never reports a missed run when there is nothing unattached', () => {
    // A processed run with everything attached is the HAPPY case; flagging it would train the operator
    // to ignore the flag.
    const rows = deriveExistingTxnContext(['a'], [txn('a', '100.00')], []);
    expect(rows[0]).toMatchObject({ unpaidCount: 0, missedTheRun: false });
  });

  it('one group flagged is enough — a later clean group does not clear it', () => {
    const rows = deriveExistingTxnContext(
      ['a'],
      [],
      [
        grp({ employmentId: 'a', runState: 'closed', count: 1, totalAmount: '50.00' }),
        grp({ employmentId: 'a', runState: 'none', count: 1, totalAmount: '50.00' }),
      ],
    );
    expect(rows[0]).toMatchObject({ unpaidCount: 2, unpaidTotal: '100.00', missedTheRun: true });
  });

  it('ignores unattached groups for employees not being keyed', () => {
    const rows = deriveExistingTxnContext(['a'], [], [grp({ employmentId: 'z', count: 9, totalAmount: '9.00' })]);
    expect(rows[0]).toMatchObject({ employmentId: 'a', unpaidCount: 0, unpaidTotal: '0.00' });
  });
});
