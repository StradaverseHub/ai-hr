/**
 * 1.2.2 Individual Transaction (ADR-0056) — a pure dated one-off payroll transaction ledger.
 *
 * Per-employee, non-recurring transactions of five kinds (earning / deduction / overtime / unpaid / leave),
 * each tied to a transaction date and belonging to exactly one month+cycle batch (payroll_batch). The screen
 * records / views / edits / deletes these before the batch is finalized.
 *
 * Scope (deliberate): this is a LEDGER only. Nothing here folds the rows into computed pay — `quantity`/`unit`
 * are descriptive and no kernel math reads them in this slice. Kernel consumption is a separate deferred slice
 * modeled on `prefillClaimsForBatch` (see ADR-0056). "No carry-forward" is satisfied by construction by the
 * `batchId` FK: a row belongs to a single batch and nothing copies it forward.
 *
 * Substrate discipline: every write appends a DomainEvent. Payloads are redaction-safe (reference ids + kind,
 * no cleartext amounts — ADR-0030 Layer-0 precedent, mirroring setEmploymentPayComponent).
 */
import { asc, eq } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employment, payrollBatch, payrollIndividualTxn, person, type PayrollTxnKind } from '../db/schema';
import { BatchNotDraftError, daysInMonth } from './payroll';

const money = (v: number) => Number(v).toFixed(2);

/** The five transaction kinds (kept in sync with payrollTxnKindEnum). */
export const TXN_KINDS = ['earning', 'deduction', 'overtime', 'unpaid', 'leave'] as const;
export type TxnKind = (typeof TXN_KINDS)[number];
export const isTxnKind = (v: unknown): v is TxnKind => TXN_KINDS.includes(v as TxnKind);

/** The descriptive unit set for `quantity` (validated app-side; mirrors the ROUNDING_METHODS pattern). */
export const TXN_UNITS = ['amount', 'qty', 'hours', 'days', 'units'] as const;
export type TxnUnit = (typeof TXN_UNITS)[number];
export const isTxnUnit = (v: unknown): v is TxnUnit => TXN_UNITS.includes(v as TxnUnit);

/** Thrown when an entry's `kind` is not one of the five supported kinds. */
export class InvalidTxnKindError extends Error {
  constructor(public readonly kind: string) {
    super(`"${kind}" is not a valid individual-transaction kind.`);
    this.name = 'InvalidTxnKindError';
  }
}

/** Thrown when an entry's `unit` is not one of the five supported units. */
export class InvalidTxnUnitError extends Error {
  constructor(public readonly unit: string) {
    super(`"${unit}" is not a valid individual-transaction unit.`);
    this.name = 'InvalidTxnUnitError';
  }
}

/** Thrown when an entry's `txnDate` is outside the batch's pay-period month (calendar-month bounds). */
export class TxnDateOutOfPeriodError extends Error {
  constructor(
    public readonly txnDate: string,
    public readonly periodStart: string,
    public readonly periodEnd: string,
  ) {
    super(`Transaction date ${txnDate} is outside the pay period ${periodStart}…${periodEnd}.`);
    this.name = 'TxnDateOutOfPeriodError';
  }
}

export type IndividualTxnRow = {
  id: string;
  employmentId: string;
  name: string;
  kind: PayrollTxnKind;
  txnDate: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  notes: string | null;
};

/** Derive the inclusive calendar-month bounds of a batch's pay period (same pattern as the kernel). */
function periodBounds(payPeriod: string): { periodStart: string; periodEnd: string } {
  const [year, month1] = payPeriod.split('-').map(Number);
  const periodStart = `${payPeriod}-01`;
  const periodEnd = `${payPeriod}-${String(daysInMonth(year, month1)).padStart(2, '0')}`;
  return { periodStart, periodEnd };
}

/** Load a draft batch (or throw if not draft / not found). Returns its period for date validation. */
async function loadDraftBatch(tx: Tx, batchId: string): Promise<{ payPeriod: string }> {
  const [batch] = await tx
    .select({ status: payrollBatch.status, payPeriod: payrollBatch.payPeriod })
    .from(payrollBatch)
    .where(eq(payrollBatch.id, batchId))
    .limit(1);
  if (!batch) throw new BatchNotDraftError();
  if (batch.status !== 'draft') throw new BatchNotDraftError();
  return { payPeriod: batch.payPeriod };
}

/** Validate that txnDate falls within the period; throw TxnDateOutOfPeriodError otherwise. */
function assertDateInPeriod(txnDate: string, payPeriod: string): void {
  const { periodStart, periodEnd } = periodBounds(payPeriod);
  if (txnDate < periodStart || txnDate > periodEnd) {
    throw new TxnDateOutOfPeriodError(txnDate, periodStart, periodEnd);
  }
}

/** List the individual transactions for a batch, joined to person name, ordered by txn date. Read-only. */
export function listIndividualTxns(ctx: SessionContext, p: { batchId: string }): Promise<IndividualTxnRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollIndividualTxn.id,
        employmentId: payrollIndividualTxn.employmentId,
        name: person.fullName,
        kind: payrollIndividualTxn.kind,
        txnDate: payrollIndividualTxn.txnDate,
        amount: payrollIndividualTxn.amount,
        quantity: payrollIndividualTxn.quantity,
        unit: payrollIndividualTxn.unit,
        notes: payrollIndividualTxn.notes,
      })
      .from(payrollIndividualTxn)
      .innerJoin(employment, eq(employment.id, payrollIndividualTxn.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payrollIndividualTxn.batchId, p.batchId))
      .orderBy(asc(payrollIndividualTxn.txnDate), asc(payrollIndividualTxn.id)),
  );
}

/**
 * Record a dated one-off transaction on a draft batch for one employee. Draft-only, date-in-period validated.
 * `amount` is the persisted money figure; `quantity`/`unit` are descriptive (any qty×rate resolution is a
 * UI/action concern, not stored semantics in this slice).
 */
export function createIndividualTxn(
  ctx: SessionContext,
  p: {
    batchId: string;
    employmentId: string;
    kind: string;
    txnDate: string;
    amount: number;
    quantity?: number | null;
    unit?: string | null;
    notes?: string | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    if (!isTxnKind(p.kind)) throw new InvalidTxnKindError(p.kind);
    if (p.unit != null && !isTxnUnit(p.unit)) throw new InvalidTxnUnitError(p.unit);
    const { payPeriod } = await loadDraftBatch(tx, p.batchId);
    assertDateInPeriod(p.txnDate, payPeriod);
    const [row] = await tx
      .insert(payrollIndividualTxn)
      .values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: p.employmentId,
        kind: p.kind,
        txnDate: p.txnDate,
        amount: money(p.amount),
        quantity: p.quantity != null ? money(p.quantity) : null,
        unit: p.unit ?? null,
        notes: p.notes ?? null,
      })
      .returning({ id: payrollIndividualTxn.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-individual-txn',
      aggregateId: row.id,
      eventType: 'payroll.individual-txn.created',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // ADR-0030 Layer 0: amount lives on the aggregate row; payload carries references + kind, not cleartext.
      payload: { batchId: p.batchId, employmentId: p.employmentId, kind: p.kind, txnDate: p.txnDate },
    });
    return { id: row.id };
  });
}

/**
 * Patch a dated one-off transaction. Draft-only; re-validates date-in-period against the (unchanged) batch
 * period. A patch may change any of kind / txnDate / amount / quantity / unit / notes.
 */
export function updateIndividualTxn(
  ctx: SessionContext,
  p: {
    id: string;
    kind?: string;
    txnDate?: string;
    amount?: number;
    quantity?: number | null;
    unit?: string | null;
    notes?: string | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        batchId: payrollIndividualTxn.batchId,
        employmentId: payrollIndividualTxn.employmentId,
        kind: payrollIndividualTxn.kind,
        txnDate: payrollIndividualTxn.txnDate,
      })
      .from(payrollIndividualTxn)
      .where(eq(payrollIndividualTxn.id, p.id))
      .limit(1);
    if (!existing) throw new BatchNotDraftError();
    const { payPeriod } = await loadDraftBatch(tx, existing.batchId);
    const nextKind = p.kind ?? existing.kind;
    if (!isTxnKind(nextKind)) throw new InvalidTxnKindError(nextKind);
    if (p.unit != null && !isTxnUnit(p.unit)) throw new InvalidTxnUnitError(p.unit);
    const nextDate = p.txnDate ?? existing.txnDate;
    assertDateInPeriod(nextDate, payPeriod);

    const patch: Record<string, unknown> = {};
    if (p.kind !== undefined) patch.kind = p.kind;
    if (p.txnDate !== undefined) patch.txnDate = p.txnDate;
    if (p.amount !== undefined) patch.amount = money(p.amount);
    if (p.quantity !== undefined) patch.quantity = p.quantity != null ? money(p.quantity) : null;
    if (p.unit !== undefined) patch.unit = p.unit ?? null;
    if (p.notes !== undefined) patch.notes = p.notes ?? null;
    if (Object.keys(patch).length > 0) {
      await tx.update(payrollIndividualTxn).set(patch).where(eq(payrollIndividualTxn.id, p.id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-individual-txn',
      aggregateId: p.id,
      eventType: 'payroll.individual-txn.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      // References only (no cleartext amount) — ADR-0030 Layer 0.
      payload: {
        before: { kind: existing.kind, txnDate: existing.txnDate },
        after: { kind: nextKind, txnDate: nextDate },
      },
    });
    return { id: p.id };
  });
}

/** Delete a dated one-off transaction. Draft-only. */
export function deleteIndividualTxn(ctx: SessionContext, p: { id: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ batchId: payrollIndividualTxn.batchId, employmentId: payrollIndividualTxn.employmentId, kind: payrollIndividualTxn.kind })
      .from(payrollIndividualTxn)
      .where(eq(payrollIndividualTxn.id, p.id))
      .limit(1);
    if (!existing) throw new BatchNotDraftError();
    await loadDraftBatch(tx, existing.batchId);
    await tx.delete(payrollIndividualTxn).where(eq(payrollIndividualTxn.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-individual-txn',
      aggregateId: p.id,
      eventType: 'payroll.individual-txn.deleted',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      payload: { batchId: existing.batchId, employmentId: existing.employmentId, kind: existing.kind },
    });
    return { id: p.id };
  });
}
