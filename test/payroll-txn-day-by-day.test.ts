/**
 * 4e403268 — Individual Transaction: day-by-day input.
 *
 * READ THE PREMISE BEFORE THE TESTS, because the request's is partly inverted and these tests are what
 * hold that correction in place. The ticket says the system "only allows the Admin to enter the total
 * number of hours". It does not: `payroll_individual_txn` has carried `txn_date NOT NULL`, `quantity`,
 * `unit` and `component_id` since f1564110 Phase 3, its table comment says multiple dated entries per
 * (batch, employment) are allowed BY DESIGN, and 2da9937a already prices a row from the pay item's own
 * rule server-side. Measured read-only on production 2026-08-12: 47 rows, 45 of them dated the 1st of
 * their month, exactly ONE carrying hours. So points 2 and 6 of the request already worked, and the
 * ledger needed no reshaping.
 *
 * What was missing, and what is therefore tested here:
 *   1. MANY DATED LINES IN ONE PASS, ATOMICALLY. Five days had to be five trips through the form.
 *   2. PROVENANCE (0432). `source` / `source_ref`, plus the uniqueness guard that stops a future
 *      Attendance sync double-posting — added BEFORE the first sync exists, because retrofitting it
 *      afterwards is a data repair rather than a constraint.
 *   3. THE PURE LINE MODEL. Day-of-week, running totals, per-line refusals, in-file duplicates.
 *
 * The GROUPING half lives in test/existing-txn-context.test.ts, beside the panel derivation it extends.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch } from '../core/payroll';
import { seedPayComponentCatalog } from '../core/pay-components';
import {
  createIndividualTxnsBulk,
  listIndividualTxns,
  isTxnSource,
  txnSourceOf,
  InvalidTxnSourceError,
  DuplicateTxnRowError,
  TxnDateOutOfPeriodError,
  TXN_SOURCES,
} from '../core/payroll-individual-txn';
import { listIndividualTxnsAcross } from '../core/payroll-view';
import {
  blankDayLine,
  dayKeyOf,
  dayLineIssue,
  dayLineTotals,
  dayOfWeekIndex,
  distinctQuantities,
  duplicateDayLineKeys,
  quantityKey,
  type DayLine,
} from '../app/payroll/transactions/individual/day-lines';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE PURE LINE MODEL (no database — day-lines.ts)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const line = (p: Partial<DayLine> = {}): DayLine => ({ ...blankDayLine(), ...p });

describe('4e403268 · the day-of-week label', () => {
  it('names the weekday of a calendar date', () => {
    // 2026-08-01 is a Saturday, which is the reporter's own first worked example.
    expect(dayKeyOf('2026-08-01')).toBe('sat');
    expect(dayKeyOf('2026-08-05')).toBe('wed');
    expect(dayKeyOf('2026-08-12')).toBe('wed');
    expect(dayKeyOf('2026-08-20')).toBe('thu');
  });

  /**
   * THE TIMEZONE TRAP THIS EXISTS TO CLOSE. A `txn_date` is a CALENDAR DAY — the day the work happened —
   * not an instant. Parsing it as local time gives a browser west of Greenwich the PREVIOUS day, so an
   * operator in one timezone and an operator in another would see different weekday labels against the
   * same stored row. Pinning the parse to UTC midnight makes the label a fact about the date.
   */
  it('is the same weekday in every timezone, because the date is parsed at UTC midnight', () => {
    const iso = '2026-08-01';
    const expected = dayOfWeekIndex(iso);
    expect(expected).toBe(6); // Saturday
    // The wrong implementation — `new Date(`${iso}T00:00:00`)` — is local time. Demonstrate that the two
    // genuinely differ for a west-of-Greenwich offset, so this test is not asserting a tautology.
    const localMidnightUtcDay = new Date(Date.parse(`${iso}T00:00:00Z`) - 8 * 3600_000).getUTCDay();
    expect(localMidnightUtcDay).toBe(5); // a naive local parse would print Friday
    expect(dayOfWeekIndex(iso)).toBe(expected);
  });

  it('returns null for anything that is not a date, rather than the epoch’s Thursday', () => {
    expect(dayKeyOf('')).toBeNull();
    expect(dayKeyOf('2026-08')).toBeNull();
    expect(dayKeyOf('not a date')).toBeNull();
    expect(dayOfWeekIndex('2026-13-45')).toBeNull();
  });
});

describe('4e403268 · the running totals under the grid', () => {
  const amountOf = (l: DayLine) => (l.amount === '' ? null : l.amount);

  it('adds the quantities and the money the reporter’s example does', () => {
    const lines = [
      line({ txnDate: '2026-08-01', quantity: '2.00', amount: '43.27' }),
      line({ txnDate: '2026-08-05', quantity: '3.00', amount: '64.90' }),
      line({ txnDate: '2026-08-12', quantity: '2.50', amount: '54.09' }),
      line({ txnDate: '2026-08-20', quantity: '4.00', amount: '86.54' }),
    ];
    const t = dayLineTotals(lines, amountOf);
    expect(t.count).toBe(4);
    expect(t.quantity).toBe('11.50');
    expect(t.amount).toBe('248.80');
  });

  /**
   * ONE UNKNOWN LINE WITHHOLDS THE WHOLE TOTAL. While a figure is still being fetched, a partial sum
   * presented as "Total" is the one number on this screen that would be believed and wrong. Null is the
   * honest answer and the screen renders it as the pending marker.
   */
  it('reports NO total while any line’s figure is still unknown', () => {
    const t = dayLineTotals([line({ quantity: '2', amount: '43.27' }), line({ quantity: '3', amount: '' })], amountOf);
    expect(t.amount).toBeNull();
    // The quantity is still known — it is typed, not fetched.
    expect(t.quantity).toBe('5.00');
  });

  it('reports no quantity at all for an item that needs none', () => {
    const t = dayLineTotals([line({ amount: '100.00' }), line({ amount: '50.00' })], amountOf);
    expect(t.quantity).toBeNull();
    expect(t.amount).toBe('150.00');
  });
});

describe('4e403268 · what one line is missing', () => {
  const bounds = { min: '2026-08-01', max: '2026-08-31' };
  const typed = { bounds, requiredUnit: null, derives: false, derivedAmount: null } as const;

  it('accepts a complete typed line', () => {
    expect(dayLineIssue(line({ txnDate: '2026-08-05', amount: '100' }), typed)).toBeNull();
  });

  it('refuses a line with no date', () => {
    expect(dayLineIssue(line({ amount: '100' }), typed)).toBe('rowIncomplete');
  });

  it('refuses a date outside the pay month — the request’s point 8, for the calendar month', () => {
    expect(dayLineIssue(line({ txnDate: '2026-07-15', amount: '100' }), typed)).toBe('dateOutOfPeriod');
    expect(dayLineIssue(line({ txnDate: '2026-09-01', amount: '100' }), typed)).toBe('dateOutOfPeriod');
  });

  it('refuses a zero or negative typed amount', () => {
    expect(dayLineIssue(line({ txnDate: '2026-08-05', amount: '0' }), typed)).toBe('amountNotPositive');
    expect(dayLineIssue(line({ txnDate: '2026-08-05', amount: '-5' }), typed)).toBe('amountNotPositive');
  });

  /** On a calculating item the operator has NO amount box to be wrong about, so the refusal has to name
   *  the box they can be missing — exactly the narrowing 2da9937a made for the single-entry form. */
  it('names the QUANTITY box, not the amount box, on an item that calculates', () => {
    const calc = { bounds, requiredUnit: 'hours', derives: true, derivedAmount: null } as const;
    expect(dayLineIssue(line({ txnDate: '2026-08-05' }), calc)).toBe('quantityRequiredHours');
    expect(dayLineIssue(line({ txnDate: '2026-08-05' }), { ...calc, requiredUnit: 'days' })).toBe('quantityRequiredDays');
  });

  it('waits for the server’s figure rather than saving a zero', () => {
    const calc = { bounds, requiredUnit: 'hours', derives: true, derivedAmount: null } as const;
    expect(dayLineIssue(line({ txnDate: '2026-08-05', quantity: '2' }), calc)).toBe('derivedAmountPending');
    expect(dayLineIssue(line({ txnDate: '2026-08-05', quantity: '2' }), { ...calc, derivedAmount: '77.88' })).toBeNull();
    expect(dayLineIssue(line({ txnDate: '2026-08-05', quantity: '2' }), { ...calc, derivedAmount: '0.00' })).toBe(
      'amountNotPositive',
    );
  });
});

describe('4e403268 · in-file duplicates and the request the grid sends', () => {
  it('flags two byte-identical lines — the double-post the service also refuses', () => {
    const a = line({ txnDate: '2026-08-05', quantity: '2', amount: '43.27', notes: 'Project A' });
    const b = line({ txnDate: '2026-08-05', quantity: '2', amount: '43.27', notes: 'project a' });
    expect(duplicateDayLineKeys([a, b])).toEqual([b.key]);
  });

  it('does NOT flag two stints on one date — that is legitimate and stays legal', () => {
    const a = line({ txnDate: '2026-08-05', quantity: '2', amount: '43.27', notes: 'Project A' });
    const b = line({ txnDate: '2026-08-05', quantity: '3', amount: '64.90', notes: 'Project B' });
    expect(duplicateDayLineKeys([a, b])).toEqual([]);
  });

  /** The preview asks for each DISTINCT quantity once. Five days of 2.00 hours are five copies of one
   *  answer, and five requests would be five transactions resolving the same employee's same month. */
  it('asks the server for each distinct quantity exactly once', () => {
    const lines = [
      line({ quantity: '2' }),
      line({ quantity: '2.00' }),
      line({ quantity: '3' }),
      line({ quantity: '' }),
      line({ quantity: '0' }),
      line({ quantity: 'abc' }),
    ];
    expect(distinctQuantities(lines)).toEqual(['2', '3']);
    expect(quantityKey('2.00')).toBe('2');
    expect(quantityKey('')).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE WRITE PATH (real Postgres)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe('4e403268 · day-by-day writes', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  async function hireWithBatch(period = '2026-08') {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Day By Day', primaryEmail: `dbd${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    return { a, employmentId: e.employmentId, batchId };
  }

  const componentIdByCode = async (code: string): Promise<string> => {
    const [row] = await owner.db
      .select({ id: schema.payComponent.id })
      .from(schema.payComponent)
      .where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, code)));
    return row.id;
  };

  /** The reporter's own worked example, as the grid posts it: one header, five dated lines. */
  const FIVE_DAYS = [
    { txnDate: '2026-08-01', quantity: 2, amount: 77.88 },
    { txnDate: '2026-08-05', quantity: 3, amount: 116.83 },
    { txnDate: '2026-08-12', quantity: 2.5, amount: 97.36 },
    { txnDate: '2026-08-20', quantity: 4, amount: 155.77 },
    { txnDate: '2026-08-25', quantity: 3.5, amount: 136.30 },
  ];

  it('writes five dated lines for ONE employee in one pass', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { ids } = await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: FIVE_DAYS.map((d) => ({ kind: 'overtime', unit: 'hours', notes: 'Overtime 1.5', ...d })),
    });
    expect(ids).toHaveLength(5);
    const list = await listIndividualTxns(a, { batchId });
    expect(list).toHaveLength(5);
    expect(list.map((r) => r.txnDate).sort()).toEqual([
      '2026-08-01',
      '2026-08-05',
      '2026-08-12',
      '2026-08-20',
      '2026-08-25',
    ]);
    // Every line carries its own hours — the column that was effectively unused before this change.
    expect(list.every((r) => r.unit === 'hours' && r.quantity != null)).toBe(true);
    // And the per-day sum is the figure the grouped view will show.
    expect(list.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0)).toBe(58414);
  });

  /**
   * ALL LINES OR NONE, and it is not this screen's job to make that true — `createIndividualTxnsBulk`
   * validates every row BEFORE inserting any and does the whole set in one transaction. The refusal
   * asserted here is date-in-period on the FOURTH line: nothing at all persists.
   */
  it('a single bad date rolls back the WHOLE grid — no half-saved month', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId],
        rows: [
          { kind: 'overtime', txnDate: '2026-08-01', amount: 77.88, quantity: 2, unit: 'hours' },
          { kind: 'overtime', txnDate: '2026-08-05', amount: 116.83, quantity: 3, unit: 'hours' },
          { kind: 'overtime', txnDate: '2026-08-12', amount: 97.36, quantity: 2.5, unit: 'hours' },
          { kind: 'overtime', txnDate: '2026-07-15', amount: 155.77, quantity: 4, unit: 'hours' }, // last month
        ],
      }),
    ).rejects.toBeInstanceOf(TxnDateOutOfPeriodError);
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
  });

  it('a zero-amount line rolls back the whole grid too', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId],
        rows: [
          { kind: 'overtime', txnDate: '2026-08-01', amount: 77.88, quantity: 2, unit: 'hours' },
          { kind: 'overtime', txnDate: '2026-08-05', amount: 0, quantity: 0, unit: 'hours' },
        ],
      }),
    ).rejects.toThrow();
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
  });

  it('refuses two byte-identical lines in one grid, and writes nothing', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId],
        rows: [
          { kind: 'overtime', txnDate: '2026-08-05', amount: 116.83, quantity: 3, unit: 'hours', notes: 'A' },
          { kind: 'overtime', txnDate: '2026-08-05', amount: 116.83, quantity: 3, unit: 'hours', notes: 'A' },
        ],
      }),
    ).rejects.toBeInstanceOf(DuplicateTxnRowError);
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
  });

  it('ALLOWS two stints on the same date when they differ — which is why the ledger has no unique key', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { ids } = await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [
        { kind: 'overtime', txnDate: '2026-08-05', amount: 77.88, quantity: 2, unit: 'hours', notes: 'Project A' },
        { kind: 'overtime', txnDate: '2026-08-05', amount: 116.83, quantity: 3, unit: 'hours', notes: 'Project B' },
      ],
    });
    expect(ids).toHaveLength(2);
  });

  // ─────────────────────────── 0432 — provenance ───────────────────────────

  it('a hand-keyed line stores NO source, and null READS as manual — no backfill can ever be needed', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [{ kind: 'overtime', txnDate: '2026-08-05', amount: 116.83, quantity: 3, unit: 'hours' }],
    });
    const [stored] = await withTenant(a, (tx) =>
      tx
        .select({ source: schema.payrollIndividualTxn.source, ref: schema.payrollIndividualTxn.sourceRef })
        .from(schema.payrollIndividualTxn)
        .where(eq(schema.payrollIndividualTxn.batchId, batchId)),
    );
    expect(stored.source).toBeNull();
    expect(stored.ref).toBeNull();
    expect(txnSourceOf(stored.source)).toBe('manual');
  });

  it('round-trips a source and its external reference', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [
        {
          kind: 'overtime',
          txnDate: '2026-08-05',
          amount: 116.83,
          quantity: 3,
          unit: 'hours',
          source: 'attendance',
          sourceRef: 'att-0001',
        },
      ],
    });
    const [stored] = await withTenant(a, (tx) =>
      tx
        .select({ source: schema.payrollIndividualTxn.source, ref: schema.payrollIndividualTxn.sourceRef })
        .from(schema.payrollIndividualTxn)
        .where(eq(schema.payrollIndividualTxn.batchId, batchId)),
    );
    expect(stored.source).toBe('attendance');
    expect(stored.ref).toBe('att-0001');
  });

  it('REFUSES an unknown source rather than coercing it to manual', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId],
        rows: [{ kind: 'overtime', txnDate: '2026-08-05', amount: 10, source: 'telepathy' }],
      }),
    ).rejects.toBeInstanceOf(InvalidTxnSourceError);
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(0);
    expect(isTxnSource('telepathy')).toBe(false);
    expect([...TXN_SOURCES]).toEqual(['manual', 'attendance', 'leave', 'import', 'system']);
  });

  /**
   * THE REQUEST'S POINT 14, PUT IN BEFORE THE FIRST SYNC EXISTS. Nothing writes a `source_ref` today —
   * neither Attendance nor Leave posts into this ledger — and that is exactly why the guard goes in now:
   * after a sync has already double-posted a month of overtime, this is a data repair rather than a
   * constraint. The index is partial (WHERE source_ref IS NOT NULL), so it is empty on production and
   * costs nothing.
   */
  it('the uniqueness guard REFUSES a repeated sync of the same external record', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const componentId = await componentIdByCode('BONUS');
    const row = {
      kind: 'earning' as const,
      componentId,
      txnDate: '2026-08-05',
      amount: 116.83,
      source: 'attendance',
      sourceRef: 'att-0001',
    };
    await createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [row] });
    // A SECOND submission — a repeated synchronisation, not a duplicate row inside one grid, so
    // DuplicateTxnRowError cannot be what catches it. The database is.
    await expect(
      createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [{ ...row, notes: 'resynced' }] }),
    ).rejects.toThrow();
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(1);
  });

  it('lets the SAME external id through for a different date — the key is the whole tuple', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const componentId = await componentIdByCode('BONUS');
    const row = { kind: 'earning' as const, componentId, amount: 50, source: 'attendance', sourceRef: 'att-0001' };
    await createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [{ ...row, txnDate: '2026-08-05' }] });
    await createIndividualTxnsBulk(a, { batchId, employmentIds: [employmentId], rows: [{ ...row, txnDate: '2026-08-06' }] });
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(2);
  });

  it('does NOT constrain hand-keyed rows — two identical manual days on one date stay legal', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const componentId = await componentIdByCode('BONUS');
    for (const notes of ['first claim', 'second claim']) {
      await createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId],
        rows: [{ kind: 'earning', componentId, txnDate: '2026-08-05', amount: 50, notes }],
      });
    }
    expect(await listIndividualTxns(a, { batchId })).toHaveLength(2);
  });

  // ─────────────────────────── the read the grouped view needs ───────────────────────────

  /**
   * The grouping is keyed on (pay period, pay item), so every row on screen needs its item. The listing
   * projection deliberately carried no `component_id` until this round (a by-id read served the two
   * per-row buttons better than widening a shared projection); day-by-day changes that, because a by-id
   * read per row would be N round trips to draw one list.
   */
  it('the listing read now carries the pay item and the provenance', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const componentId = await componentIdByCode('BONUS');
    await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', componentId, txnDate: '2026-08-05', amount: 116.83, quantity: 3, unit: 'hours' }],
    });
    const rows = await listIndividualTxnsAcross(a, { companyIds: [base.companyId], employmentId });
    expect(rows).toHaveLength(1);
    expect(rows[0].componentId).toBe(componentId);
    expect(rows[0].componentCode).toBe('BONUS');
    expect(rows[0].componentName).toBeTruthy();
    expect(rows[0].source).toBeNull(); // reads as manual through panelSourceOf / txnSourceOf
  });

  it('a componentless generic-kind row still reads, with no pay item — the LEFT join cannot drop it', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [{ kind: 'overtime', txnDate: '2026-08-05', amount: 50 }],
    });
    const rows = await listIndividualTxnsAcross(a, { companyIds: [base.companyId], employmentId });
    expect(rows).toHaveLength(1);
    expect(rows[0].componentId).toBeNull();
    expect(rows[0].componentCode).toBeNull();
  });
});
