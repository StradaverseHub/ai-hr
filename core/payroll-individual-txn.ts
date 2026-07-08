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
import { asc, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employment, payrollBatch, payrollIndividualTxn, person, type PayrollTxnKind } from '../db/schema';
import { BatchNotDraftError, daysInMonth, resolveBatchScopeFilter, type BatchScope } from './payroll';

const money = (v: number) => Number(v).toFixed(2);

/** The five transaction kinds (kept in sync with payrollTxnKindEnum). */
export const TXN_KINDS = ['earning', 'deduction', 'overtime', 'unpaid', 'leave'] as const;
export type TxnKind = (typeof TXN_KINDS)[number];
export const isTxnKind = (v: unknown): v is TxnKind => TXN_KINDS.includes(v as TxnKind);

/** The descriptive unit set for `quantity` (validated app-side; mirrors the ROUNDING_METHODS pattern). */
export const TXN_UNITS = ['amount', 'qty', 'hours', 'days', 'units'] as const;
export type TxnUnit = (typeof TXN_UNITS)[number];
export const isTxnUnit = (v: unknown): v is TxnUnit => TXN_UNITS.includes(v as TxnUnit);

/** Thrown when an individual-transaction row is absent (missing / already-deleted id). Distinct from
 *  `BatchNotDraftError`, which is reserved for the real non-draft batch case. */
export class TxnNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Individual transaction ${id} was not found.`);
    this.name = 'TxnNotFoundError';
  }
}

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

/** Thrown when a bulk row's `amount` is not strictly positive. Deductions are represented by
 *  kind='deduction' with a POSITIVE magnitude (the ledger stores amounts as magnitudes via money()),
 *  so zero/negative is never a legitimate value. Kept as a validation-key throw (not an exported class)
 *  per the actions.ts friendly-key pattern; surfaced as the 'amountNotPositive' key. */
export class AmountNotPositiveError extends Error {
  constructor(public readonly amount: number) {
    super(`Amount ${amount} must be greater than zero.`);
    this.name = 'AmountNotPositiveError';
  }
}

/** Thrown when the chosen employment does not belong to the batch's company. The employee-first flow can
 *  otherwise resolve a batch in the wrong company (createIndividualTxn does not cross-check), so the bulk
 *  wrapper is the defence-in-depth backstop behind the UI's company filter (C3). */
export class CompanyMismatchError extends Error {
  constructor(
    public readonly employmentCompanyId: string,
    public readonly batchCompanyId: string,
  ) {
    super(`Employment company ${employmentCompanyId} does not match batch company ${batchCompanyId}.`);
    this.name = 'CompanyMismatchError';
  }
}

/** Thrown when the batch's scope (departments / explicit employments) excludes the chosen employment.
 *  A scoped batch narrows generation to a subset; the ledger FK does not enforce membership, so an
 *  out-of-scope row would be silently ignored at generation — reject it here instead (C4). */
export class EmploymentNotInBatchScopeError extends Error {
  constructor(
    public readonly employmentId: string,
    public readonly batchId: string,
  ) {
    super(`Employment ${employmentId} is not in the scope of batch ${batchId}.`);
    this.name = 'EmploymentNotInBatchScopeError';
  }
}

/** Thrown when a multi-employee bulk save is called with an empty employee selection. The wizard now
 *  supports selecting one OR many employees; zero is never valid — a save must name at least one payee. */
export class EmptyEmployeeSelectionError extends Error {
  constructor() {
    super('At least one employee must be selected for a one-off transaction.');
    this.name = 'EmptyEmployeeSelectionError';
  }
}

/** Thrown when the submitted grid contains two IDENTICAL rows (same kind + date + amount + remarks). Two
 *  legitimate same-day claims always differ in amount or remarks; a byte-for-byte duplicate row is a keying
 *  mistake (a double paste / double-click), so we reject it before write rather than silently double-post the
 *  same allowance/deduction. Detection is scoped to WITHIN one submission — recording the same grid for many
 *  employees (the multi-employee cartesian) is expressly allowed and never treated as a duplicate. */
export class DuplicateTxnRowError extends Error {
  constructor(public readonly signature: string) {
    super(`Duplicate transaction row: ${signature}.`);
    this.name = 'DuplicateTxnRowError';
  }
}

/** Canonical signature of a grid row for duplicate detection (kind + date + normalised amount + remarks). */
function txnRowSignature(r: { kind: string; txnDate: string; amount: number; notes?: string | null }): string {
  return [r.kind, r.txnDate, money(r.amount), (r.notes ?? '').trim().toLowerCase()].join('|');
}

export type IndividualTxnRow = {
  id: string;
  employmentId: string;
  name: string;
  employeeCode: string | null;
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

/** Load a draft batch (or throw if not draft / not found). Returns period + company + scope so the bulk
 *  wrapper can enforce the C3 (company match) and C4 (scope membership) correctness guards. Exported for
 *  the bulk wrapper (C5); the single-row methods below keep using it too, ignoring the extra columns. */
export async function loadDraftBatch(
  tx: Tx,
  batchId: string,
): Promise<{ payPeriod: string; companyId: string; scope: BatchScope | null }> {
  const [batch] = await tx
    .select({
      status: payrollBatch.status,
      payPeriod: payrollBatch.payPeriod,
      companyId: payrollBatch.companyId,
      scope: payrollBatch.scope,
    })
    .from(payrollBatch)
    .where(eq(payrollBatch.id, batchId))
    .limit(1);
  if (!batch) throw new BatchNotDraftError();
  if (batch.status !== 'draft') throw new BatchNotDraftError();
  return { payPeriod: batch.payPeriod, companyId: batch.companyId, scope: (batch.scope as BatchScope | null) ?? null };
}

/** Validate that txnDate falls within the period; throw TxnDateOutOfPeriodError otherwise. Exported for
 *  the bulk wrapper (C5) so it re-uses the identical calendar-month bounds the single-row path uses. */
export function assertDateInPeriod(txnDate: string, payPeriod: string): void {
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
        employeeCode: employment.employeeCode, // Employee ID left-of-name (feedback 38668d9b)
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

/** One editable grid row for the bulk save (Step 3 of the wizard). */
export type BulkTxnRow = {
  kind: string;
  txnDate: string;
  amount: number;
  quantity?: number | null;
  unit?: string | null;
  notes?: string | null;
};

/**
 * 1.2.2 — Save a whole grid of dated one-off transactions for ONE OR MANY employees against ONE draft
 * batch, in a SINGLE transaction (the wizard's Step 4 "save all valid entries in one transaction"). The
 * same grid of rows is recorded for EVERY selected employee (a cartesian product: rows × employees), so a
 * payroll admin can pay the same allowance/deduction to twenty people in one atomic pass. Either every row
 * for every employee commits or none does — a mid-transaction failure on any later row rolls back all the
 * earlier inserts and their events. This is the ONE net-new backend method; it deliberately does NOT loop
 * createIndividualTxn / call itself per employee (that opens N transactions with no cross-employee
 * rollback — C5/scope-creep note). Multi-employee is done INSIDE this one transaction.
 *
 * Correctness guards, in order (fail fast, whole-transaction rollback):
 *  - non-empty selection (EmptyEmployeeSelectionError) — at least one payee is required.
 *  - draft batch (BatchNotDraftError) — re-checked inside the transaction so a draft→non-draft flip
 *    between selection and save loses nothing (C8/C10).
 *  - company match PER employee: employment.companyId == batch.companyId (CompanyMismatchError, C3).
 *  - scope membership PER employee: employment ∈ batch.scope (EmploymentNotInBatchScopeError, C4).
 *  - per row: valid kind / unit; date-in-period (assertDateInPeriod); amount > 0 (AmountNotPositiveError, C6).
 *
 * One 'payroll.individual-txn.created' DomainEvent is appended PER inserted row (aggregateId = the new row
 * id, subjectEmploymentId = that row's employee), byte-identical in shape to createIndividualTxn's event,
 * so per-record History/replay attach and the substrate-coverage grep passes (C7).
 */
export function createIndividualTxnsBulk(
  ctx: SessionContext,
  p: { batchId: string; employmentIds: string[]; rows: BulkTxnRow[] },
): Promise<{ ids: string[] }> {
  return withTenant(ctx, async (tx) => {
    // De-dupe the selection defensively (a repeated employee would double-post the grid) and require ≥1 payee.
    const employmentIds = [...new Set(p.employmentIds)];
    if (employmentIds.length === 0) throw new EmptyEmployeeSelectionError();

    // Load + validate the draft batch ONCE inside the transaction (C5/C8: the draft re-check happens here).
    const { payPeriod, companyId: batchCompanyId, scope } = await loadDraftBatch(tx, p.batchId);

    // C3 (per employee) — every chosen employment must belong to the batch's company. One `inArray` query
    // fetches them all; a missing / mismatched employment fails the whole transaction (nothing persists).
    const emps = await tx
      .select({ id: employment.id, companyId: employment.companyId })
      .from(employment)
      .where(inArray(employment.id, employmentIds));
    const companyById = new Map(emps.map((e) => [e.id, e.companyId]));
    for (const eid of employmentIds) {
      const cid = companyById.get(eid);
      if (cid == null || cid !== batchCompanyId) {
        throw new CompanyMismatchError(cid ?? 'unknown', batchCompanyId);
      }
    }

    // C4 (per employee) — every employment must be within the batch's scope (departments ∪ explicit
    // employments). A null/empty scope means "whole company" (already company-matched above), so no
    // membership check is needed then.
    const { employmentIds: scopeIds } = await resolveBatchScopeFilter(tx, scope);
    if (scopeIds !== null) {
      for (const eid of employmentIds) {
        if (!scopeIds.includes(eid)) throw new EmploymentNotInBatchScopeError(eid, p.batchId);
      }
    }

    // Validate every row BEFORE inserting any (fail fast) into a typed set — the transaction still guarantees
    // all-or-nothing if a later insert fails (e.g. numeric overflow), which the real-rollback test exercises (C8).
    const validated: Array<{ kind: TxnKind; txnDate: string; amount: number; quantity?: number | null; unit?: string | null; notes?: string | null }> = [];
    const seenSignatures = new Set<string>();
    for (const r of p.rows) {
      if (!isTxnKind(r.kind)) throw new InvalidTxnKindError(r.kind);
      if (r.unit != null && !isTxnUnit(r.unit)) throw new InvalidTxnUnitError(r.unit);
      assertDateInPeriod(r.txnDate, payPeriod);
      if (!(r.amount > 0)) throw new AmountNotPositiveError(r.amount); // C6 — magnitude semantics, all 5 kinds
      // Duplicate-record validation: reject a byte-for-byte identical row within the same submission (the
      // reporter's "validate duplicate records before submission"). Distinct amounts/remarks pass through; the
      // multi-employee cartesian below is NOT a duplicate (same grid, different payee).
      const sig = txnRowSignature(r);
      if (seenSignatures.has(sig)) throw new DuplicateTxnRowError(sig);
      seenSignatures.add(sig);
      validated.push({ kind: r.kind, txnDate: r.txnDate, amount: r.amount, quantity: r.quantity, unit: r.unit, notes: r.notes });
    }

    // Cartesian insert: the validated grid is recorded once per selected employee. Outer loop = employees so
    // each row's subjectEmploymentId / payload employmentId names the right payee.
    const ids: string[] = [];
    for (const eid of employmentIds) {
      for (const r of validated) {
        const [row] = await tx
          .insert(payrollIndividualTxn)
          .values({
            tenantId: ctx.tenantId,
            batchId: p.batchId,
            employmentId: eid,
            kind: r.kind,
            txnDate: r.txnDate,
            amount: money(r.amount),
            quantity: r.quantity != null ? money(r.quantity) : null,
            unit: r.unit ?? null,
            notes: r.notes ?? null,
          })
          .returning({ id: payrollIndividualTxn.id });
        // C7 — one event PER row, byte-identical in shape to the single-row create event.
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'payroll-individual-txn',
          aggregateId: row.id,
          eventType: 'payroll.individual-txn.created',
          actor: actorOf(ctx),
          subjectEmploymentId: eid,
          // ADR-0030 Layer 0: references + kind, no cleartext amount.
          payload: { batchId: p.batchId, employmentId: eid, kind: r.kind, txnDate: r.txnDate },
        });
        ids.push(row.id);
      }
    }
    return { ids };
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
    if (!existing) throw new TxnNotFoundError(p.id); // distinct from BatchNotDraftError (real non-draft case)
    const { payPeriod } = await loadDraftBatch(tx, existing.batchId);
    const nextKind = p.kind ?? existing.kind;
    if (!isTxnKind(nextKind)) throw new InvalidTxnKindError(nextKind);
    if (p.unit != null && !isTxnUnit(p.unit)) throw new InvalidTxnUnitError(p.unit);
    const nextDate = p.txnDate ?? existing.txnDate;
    assertDateInPeriod(nextDate, payPeriod);
    // C6 — the retained edit path is the OTHER surviving write surface (the create-form path is removed).
    // Enforce the same amount>0 magnitude rule the bulk save enforces, so both write paths agree.
    if (p.amount !== undefined && !(p.amount > 0)) throw new AmountNotPositiveError(p.amount);

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
    if (!existing) throw new TxnNotFoundError(p.id); // distinct from BatchNotDraftError (real non-draft case)
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
