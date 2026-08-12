/**
 * 44129979 — pure derivation of the Individual Transaction screen's RIGHT PANEL from two reads that
 * already exist. No React, no db, no i18n, so the arithmetic and the status rule are unit-testable
 * (test/existing-txn-context.test.ts).
 *
 * This replaces ec845c7d's summary-only derivation. The reporter's complaint was never that the screen
 * showed nothing about existing transactions — it already showed a per-employee count and total. It was
 * that the count and total are not the entries: you cannot see WHICH transactions are behind the figure,
 * so you cannot review one before adding another. So the panel is now ITEMISED, and the totals are
 * derived from exactly the rows on screen rather than from a second read that could disagree with them.
 *
 * THREE STATUSES, AND THE THIRD IS STILL DERIVED — NOTHING IS STORED. `payroll_individual_txn` has no
 * status column and 510f4bd1 did not add one. What the data supports is: a row whose batch is processed or
 * closed has been paid; a row that is unattached (keyed before the month's run existed) or attached to a
 * draft run has not; and — 510f4bd1 — a row on a PROCESSED run that is not in the payslip that run last
 * produced for its employee has been superseded and needs the run recalculated. ec845c7d's request asked
 * for four (Draft, Pending Payroll, Processed, Cancelled): there is no draft state (a row exists or it does
 * not) and no cancelled state (removing one deletes it). 510f4bd1's asked for six; `Processing`, `Failed`
 * and `Reprocessed` are not built because none of them is a RESTING state a row can be rendered in — see
 * the note on `reprocessRequired` below. Inventing a status no column backs would put a claim on screen the
 * data cannot support, so `txnStatusOf` returns exactly the three that are derivable, and anything that is
 * not demonstrably paid degrades to `pending` — an unknown batch status is never proof of payment.
 *
 * EDITABILITY FOLLOWS THE SERVICE, NOT THE OTHER WAY ROUND. `updateIndividualTxn` / `deleteIndividualTxn`
 * accept a row while it is unattached or on a batch in WRITABLE_BATCH_STATUSES and refuse it otherwise
 * (BatchNotDraftError). `editable` mirrors that rule so the row actions are disabled where the write would
 * be rejected, rather than offering a button that always fails.
 *
 * 49e7e0a2 WIDENED THAT SET TO INCLUDE `processed`, AND `editable` IS NOW INDEPENDENT OF `status`. Before
 * this round the two were the same question — a paid row was a frozen row — and `editable: status ===
 * 'pending'` said so in one expression. They have come apart: a row on a processed run HAS been paid
 * (status 'processed') and may STILL be corrected (editable), because the correction marks the run for
 * recalculation instead of quietly diverging from it. `recalcOnEdit` is what carries that second fact to
 * the screen, so the operator is told what a save on this row will cost before they make it. A CLOSED run
 * is still frozen, in the app and by the 0011 database triggers underneath it.
 *
 * STRANDED MONEY IS A SEPARATE QUESTION AND STAYS SEPARATE. `listUnattachedTxnSummary` (d0d2c9d1) answers
 * "which money was entered and never reached a payslip, and has the month's run already gone past it".
 * That is a FAULT alert, not a status — the same row already carries its status from the rule above — so
 * it is surfaced as a per-month warning band and deliberately not as a competing count. Nothing here
 * invents a second definition of either.
 *
 * MONEY IS SUMMED IN INTEGER CENTS, and here is the honest reason, because the obvious one is wrong.
 * ec845c7d's version of this module claimed cents was preventing float drift on the totals. It is not:
 * the ledger stores `numeric(12,2)`, and for two-decimal inputs a float sum prints the SAME `toFixed(2)`
 * — searched exhaustively over random 2-to-6-row combinations without finding one divergence. What cents
 * actually buys is that the total is exact rather than exact-only-because-the-formatter-hides-it, so the
 * next person to widen the input (a sub-cent quantity, a pre-summed figure) does not silently introduce
 * a fault. The tests assert exact totals accordingly, and say so — they do not claim to catch a drift
 * these inputs cannot produce.
 */

// 510f4bd1 — the ONE rule for "is this row in the employee's latest payslip?", shared with the server read
// that feeds the Transaction View grid and its CSV (core/payroll-view.ts). Pure and db-free, so importing
// it here does not drag anything across the RSC boundary into the client workspace.
import { individualTxnReprocessRequired } from '@/core/individual-txn-status';

/**
 * The three statuses the ledger actually supports. See the module doc for why there are not four, and not
 * the six 510f4bd1 listed.
 *
 * `reprocessRequired` is rendered as "Pending reprocessing" — the reporter's own words, and deliberately
 * the same vocabulary fbcf706d put on the Reprocess screen, so the two screens describe one condition once.
 */
export type TxnStatus = 'pending' | 'processed' | 'reprocessRequired';

/** The fields this module needs from an IndividualTxnViewRow (core/payroll-view.ts). */
export type TxnPanelInputRow = {
  id: string;
  employmentId: string;
  payPeriod: string;
  txnDate: string;
  kind: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  notes: string | null;
  /** 4e403268 — the pay item this line was keyed against, and where the line came from. All four are
   *  OPTIONAL and their absence makes NO claim, exactly as `facts` on `txnStatusOf` does: callers that
   *  have them always pass them (`listIndividualTxnsAcross` fills all four), and a fixture that omits them
   *  gets a group keyed on the generic kind and a source of 'manual', which is what such a row is. */
  componentId?: string | null;
  componentCode?: string | null;
  componentName?: string | null;
  source?: string | null;
  runType: string | null;
  runSeq: number | null;
  batchStatus: string | null;
  /** Audit provenance, already on the listing row — the request's "View" needs it and nothing else does. */
  createdOn: string;
  createdBy: string | null;
  // ── 510f4bd1 — already on the listing row too; see core/individual-txn-status.ts for what they mean. ──
  /** `coalesce(txn.updated_at, txn.created_at)`. */
  changedAt: string;
  /** `payslip.created_at` for this (batch, employment); null when the employee has no payslip on the run. */
  payslipCalculatedAt: string | null;
  /** The RUN's own verdict on this employment — the authoritative employee-level fact. Carried through to
   *  `TxnPanelRow` so the screen can explain a row that reads Processed under an employee who is waiting
   *  to be recalculated (an attendance-driven recompute, or a delete that left no row to label). It is
   *  deliberately NOT an input to `txnStatusOf`: the row badge is about the ROW. */
  batchNeedsRecalcForEmployment: boolean;
};

/** The fields this module needs from an UnattachedGroupRow (core/payroll-view.ts). */
export type StrandedInputRow = {
  payPeriod: string;
  count: number;
  totalAmount: string;
  runState: 'none' | 'draft' | 'processed' | 'closed';
  arrivedAfterProcessing: boolean;
};

/** 4e403268 — the ledger's provenance vocabulary, mirrored here as a literal for the same reason
 *  WRITABLE_BATCH_STATUSES is: this pure module and the client component that consumes it must never
 *  import the DB-touching service across the RSC boundary. core/payroll-individual-txn.ts TXN_SOURCES is
 *  authoritative; test/existing-txn-context.test.ts pins the two lists equal. */
export const TXN_SOURCE_LABELS = ['manual', 'attendance', 'leave', 'import', 'system'] as const;

/** A stored `source` as the screen reads it. NULL — every row written before 0432 — means 'manual', which
 *  is the truth about all of them, and NOT "unknown". An unrecognised value degrades the same way rather
 *  than rendering a token the operator has never seen. */
export const panelSourceOf = (v: string | null | undefined): string =>
  (TXN_SOURCE_LABELS as readonly string[]).includes(v ?? '') ? (v as string) : 'manual';

export type TxnPanelRow = Omit<TxnPanelInputRow, 'source'> & {
  /** The NORMALISED provenance — always one of TXN_SOURCE_LABELS, never null. */
  source: string;
  status: TxnStatus;
  /** True while the row may still be changed — mirrors the service's unattached / draft / processed rule. */
  editable: boolean;
  /** False while the row is period-keyed and waiting for the month's regular run to collect it. */
  attached: boolean;
  /** True when changing this row makes an already-processed run's payslips, statutory figures and totals
   *  stale, and marks that run for recalculation. */
  recalcOnEdit: boolean;
};

/**
 * The batch statuses in which a ledger row may still be written — the CLIENT-SIDE mirror of
 * `WRITABLE_BATCH_STATUSES` (core/payroll-individual-txn.ts), kept as a literal here so this pure module
 * (and the client component that consumes it) never imports the DB-touching service across the RSC
 * boundary. The service is authoritative; this only decides whether a button is offered.
 */
const WRITABLE_BATCH_STATUSES = ['draft', 'processed'] as const;

/**
 * May this row still be changed? Unattached (no run yet) or on a run in a writable status. A `closed` run —
 * and equally a status this build does not recognise — is NOT writable: the service refuses it and the
 * 0011 triggers refuse it underneath, so offering the button would only produce a failed save.
 */
export function txnEditableOf(batchStatus: string | null | undefined): boolean {
  if (batchStatus == null) return true;
  return (WRITABLE_BATCH_STATUSES as readonly string[]).includes(batchStatus);
}

/**
 * THREE MUTUALLY EXCLUSIVE BUCKETS THAT STILL SUM TO count/total. Before 510f4bd1 there were two and the
 * loop below was an if/else on `pending`, so the else branch silently meant "processed"; adding a third
 * status without splitting that branch would have counted every stale row as paid — the exact claim the
 * request exists to stop the screen making.
 */
export type TxnPanelTotals = {
  count: number;
  /** Fixed-2 ringgit-style strings; the caller formats them through lib/money with the company currency. */
  total: string;
  pendingCount: number;
  pendingTotal: string;
  processedCount: number;
  processedTotal: string;
  /** 510f4bd1 — money that is on a processed run but NOT in the employee's latest payslip. */
  reprocessCount: number;
  reprocessTotal: string;
};

/** One month in which money was entered and the month's regular run has already gone without it. */
export type StrandedPeriod = { payPeriod: string; count: number; total: string };

export type TxnPanel = { rows: TxnPanelRow[]; totals: TxnPanelTotals; stranded: StrandedPeriod[] };

const cents = (v: string | null | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const fixed2 = (c: number) => (c / 100).toFixed(2);

/**
 * The status of one ledger row.
 *
 * `processed` and `closed` are the two batch states that mean payslips exist, so the row has been paid.
 * NULL (unattached — no run yet) and `draft` mean it has not. Any other value is treated as pending:
 * this is the one place the screen could claim someone has been paid, and a status it does not recognise
 * is not evidence of that.
 *
 * 510f4bd1 ADDED THE THIRD ANSWER AND IT TAKES PRECEDENCE OVER `processed`. A row on a processed run that
 * is not in the payslip that run last produced reads `reprocessRequired`, because `Processed` has to mean
 * exactly one thing: this amount is in the employee's latest payslip. The comparison itself lives in
 * core/individual-txn-status.ts so this screen, the Transaction View grid and the CSV all apply one rule.
 *
 * `facts` is OPTIONAL and its absence makes NO claim — an omitted `payslipCalculatedAt` is not the same as
 * a null one (null means "no payslip on the run", which IS evidence of staleness). Callers that have the
 * facts always pass them; `buildTxnPanel` does.
 */
export function txnStatusOf(
  batchStatus: string | null | undefined,
  facts?: { changedAt?: string | null; payslipCalculatedAt?: string | null },
): TxnStatus {
  if (
    individualTxnReprocessRequired({
      batchStatus,
      changedAt: facts?.changedAt,
      payslipCalculatedAt: facts?.payslipCalculatedAt,
    })
  ) {
    return 'reprocessRequired';
  }
  return batchStatus === 'processed' || batchStatus === 'closed' ? 'processed' : 'pending';
}

/**
 * Build the right panel for ONE employee: every row it will show, the totals of exactly those rows, and
 * the months whose money has already missed the run.
 *
 * `stranded` is filtered here rather than in the query so the query keeps answering its own question
 * (all unattached money, whatever its cause — the distinction d0d2c9d1 insisted on keeping visible) and
 * this screen selects the subset that is a fault: the month's regular run is past draft, or the row was
 * keyed after that run was processed. A month with no run yet is the DESIGNED pre-run entry flow and is
 * not a fault, so it is not warned about.
 */
export function buildTxnPanel(
  rows: readonly TxnPanelInputRow[],
  stranded: readonly StrandedInputRow[] = [],
): TxnPanel {
  const panelRows: TxnPanelRow[] = rows.map((r) => {
    const status = txnStatusOf(r.batchStatus, {
      changedAt: r.changedAt,
      payslipCalculatedAt: r.payslipCalculatedAt,
    });
    return {
      ...r,
      source: panelSourceOf(r.source),
      status,
      editable: txnEditableOf(r.batchStatus),
      attached: r.batchStatus != null,
      recalcOnEdit: r.batchStatus === 'processed',
    };
  });

  let totalC = 0;
  let pendingC = 0;
  let processedC = 0;
  let reprocessC = 0;
  let pendingN = 0;
  let processedN = 0;
  let reprocessN = 0;
  // THREE-WAY, not if/else. This was `if (pending) … else processed`, and leaving it that way would have
  // folded every Pending-reprocessing row into the Paid figure — the screen would then have TOLD the
  // operator that money is in the payslip while the badge beside it said it is not.
  for (const r of panelRows) {
    const c = cents(r.amount);
    totalC += c;
    if (r.status === 'pending') {
      pendingC += c;
      pendingN += 1;
    } else if (r.status === 'reprocessRequired') {
      reprocessC += c;
      reprocessN += 1;
    } else {
      processedC += c;
      processedN += 1;
    }
  }

  const byPeriod = new Map<string, { count: number; cents: number }>();
  for (const g of stranded) {
    const missed = g.arrivedAfterProcessing || g.runState === 'processed' || g.runState === 'closed';
    if (!missed) continue;
    const a = byPeriod.get(g.payPeriod) ?? { count: 0, cents: 0 };
    a.count += g.count;
    a.cents += cents(g.totalAmount);
    byPeriod.set(g.payPeriod, a);
  }

  return {
    rows: panelRows,
    totals: {
      count: panelRows.length,
      total: fixed2(totalC),
      pendingCount: pendingN,
      pendingTotal: fixed2(pendingC),
      processedCount: processedN,
      processedTotal: fixed2(processedC),
      reprocessCount: reprocessN,
      reprocessTotal: fixed2(reprocessC),
    },
    stranded: [...byPeriod.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)) // newest month first, like the listing
      .map(([payPeriod, a]) => ({ payPeriod, count: a.count, total: fixed2(a.cents) })),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// 4e403268 — DAY-BY-DAY GROUPING
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One (pay period, pay item) group: the request's point 7 ("the payroll result should still show
 * Overtime 1.5 – RM248.80 while the detailed daily records remain available") and point 16 (the daily
 * breakdown survives payroll processing, as the audit trail behind the figure).
 *
 * Derived, never stored. Nothing about the ledger changes to produce this — the rows were always there,
 * one per date; what was missing was anything that added them up.
 */
export type TxnGroup = {
  /** Stable identity for React keys and for the expand/collapse set: `${payPeriod}|${componentId ?? kind}`. */
  key: string;
  payPeriod: string;
  /** Null for a generic-kind row that names no Payroll Item Master component. */
  componentId: string | null;
  /** The pay item's code, or null when the group is a generic kind. */
  componentCode: string | null;
  /** The pay item's name, or null when the group is a generic kind — the caller falls back to the kind
   *  label, which is an i18n concern and therefore not this module's business. */
  componentName: string | null;
  /** The ledger kind every row in the group shares (a group is keyed within one pay item, and a pay item
   *  maps to exactly one kind). */
  kind: string;
  count: number;
  /**
   * THE SUMMED QUANTITY, AND IT IS NULL MORE OFTEN THAN YOU MIGHT EXPECT — on purpose.
   *
   * It is a figure only when EVERY row in the group carries a quantity AND they all agree on the unit.
   * Two hours and three days do not add up to five of anything, and printing "5.00" over a mixed group
   * would be a number that means nothing sitting directly above the rows that disprove it. Mixed, or
   * partially absent, reads as null and the screen shows a dash.
   */
  quantity: string | null;
  /** The unit those quantities are in, when they agree; null whenever `quantity` is null. */
  unit: string | null;
  /** Summed in integer cents, like the panel totals, and for the same reason (see the module doc). */
  total: string;
  /**
   * THE GROUP'S STATUS, and the precedence is the whole point. 510f4bd1 split one boolean into three
   * states, and a group must not undo that split: a group holding ONE row that is not in the employee's
   * latest payslip is not "Processed", and a group holding one unpaid row is not "Processed" either.
   * So: any reprocessRequired ⇒ reprocessRequired; else any pending ⇒ pending; else processed.
   *
   * The direction is deliberate and it is the safe one — this is the one place the screen could claim
   * money has been paid, and a mixed group is not evidence of that.
   */
  status: TxnStatus;
  /** The per-status counts behind that verdict, so the screen can be specific rather than only cautious. */
  pendingCount: number;
  processedCount: number;
  reprocessCount: number;
  /** True when ANY row in the group came from somewhere other than a person typing it. Nothing sets this
   *  today (nothing writes a non-manual source yet); it exists so the grouped view does not need changing
   *  when Attendance and Leave learn to post. */
  hasExternalSource: boolean;
  /** The member rows, newest date last — the reading order of a month, and the same order the flat
   *  listing uses within a month. */
  rows: TxnPanelRow[];
};

/** The group key for one row: the pay item when it has one, otherwise the generic kind. Exported so the
 *  screen can highlight the group a freshly-saved row landed in without re-deriving the rule. */
export const txnGroupKey = (r: { payPeriod: string; componentId?: string | null; kind: string }): string =>
  `${r.payPeriod}|${r.componentId ?? `k:${r.kind}`}`;

/**
 * Group an employee's panel rows by (pay period, pay item) and total each group.
 *
 * PURE. No React, no db, no i18n — the same split as `buildTxnPanel` above, and for the same reason: the
 * arithmetic, the mixed-unit refusal and the status precedence are the parts worth unit-testing, and none
 * of them needs a session.
 *
 * Groups come back newest month first (matching the listing's default sort), and within a month by pay
 * item code so two months of the same item read down the screen in the same column order.
 */
export function buildTxnGroups(rows: readonly TxnPanelRow[]): TxnGroup[] {
  const groups = new Map<string, TxnGroup & { _cents: number; _qtyCents: number }>();

  for (const r of rows) {
    const key = txnGroupKey(r);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        payPeriod: r.payPeriod,
        componentId: r.componentId ?? null,
        componentCode: r.componentCode ?? null,
        componentName: r.componentName ?? null,
        kind: r.kind,
        count: 0,
        quantity: null,
        unit: r.unit ?? null,
        total: '0.00',
        status: 'processed',
        pendingCount: 0,
        processedCount: 0,
        reprocessCount: 0,
        hasExternalSource: false,
        rows: [],
        _cents: 0,
        _qtyCents: 0,
      };
      groups.set(key, g);
    }
    g.count += 1;
    g._cents += cents(r.amount);
    g.rows.push(r);
    if (r.status === 'pending') g.pendingCount += 1;
    else if (r.status === 'reprocessRequired') g.reprocessCount += 1;
    else g.processedCount += 1;
    if (r.source !== 'manual') g.hasExternalSource = true;
    // The mixed-unit refusal, applied incrementally: `unit` is set to '' the moment two rows disagree or
    // one row carries no quantity at all, and '' can never become a unit again.
    if (r.quantity == null || r.unit == null || (g.unit !== null && g.unit !== r.unit)) g.unit = '';
    else g._qtyCents += cents(r.quantity);
  }

  return [...groups.values()]
    .map((g) => {
      const { _cents, _qtyCents, ...rest } = g;
      const summable = rest.unit !== '' && rest.unit !== null;
      return {
        ...rest,
        total: fixed2(_cents),
        quantity: summable ? fixed2(_qtyCents) : null,
        unit: summable ? rest.unit : null,
        // Precedence, stated once: not-in-the-latest-payslip beats unpaid beats paid.
        status: (rest.reprocessCount > 0
          ? 'reprocessRequired'
          : rest.pendingCount > 0
            ? 'pending'
            : 'processed') as TxnStatus,
        rows: [...rest.rows].sort((a, b) =>
          a.txnDate !== b.txnDate ? (a.txnDate < b.txnDate ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      };
    })
    .sort((a, b) => {
      if (a.payPeriod !== b.payPeriod) return a.payPeriod < b.payPeriod ? 1 : -1; // newest month first
      const ac = a.componentCode ?? a.kind;
      const bc = b.componentCode ?? b.kind;
      return ac < bc ? -1 : ac > bc ? 1 : a.key < b.key ? -1 : 1;
    });
}
