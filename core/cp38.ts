/**
 * 1.2.3 CP38 Deduction (ADR-0057) — an LHDN/court instalment deducted each payroll month IN ADDITION to
 * monthly MTD/PCB. Per-employment, effective-dated, supersede-on-write (mirrors `core/comp.ts`
 * setCompensation): a change CLOSEs the open row (sets its `validTo`) and INSERTs a new open row, so at
 * most one CP38 row applies to any given month. The Postgres gist EXCLUDE (`employee_cp38_no_overlap`,
 * migration 0117) is the backstop against a concurrent-write overlap — a silent duplicate garnishment is
 * a compliance hazard, so it must be structurally impossible, not merely app-checked.
 *
 * GRANULARITY — month-aligned. The feature is "by year and month". `validFrom`/`validTo` are stored as
 * `date` but every input is NORMALISED to the first day of its month (`YYYY-MM-01`); `cp38ForPeriod`
 * compares against the payroll period's month bucket. A mid-month instruction therefore charges the whole
 * month it starts in. (Documented in the admin form hint.)
 *
 * Substrate discipline (ADR-0006 / ADR-0030 Layer 0): every write appends a DomainEvent whose payload
 * carries references + dates only — never the cleartext CP38 amount, which lives on the aggregate row.
 */
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { employeeCp38, payrollBatch, payslip } from '../db/schema';

import { todayInKualaLumpur } from '../lib/hr-date';

const money = (n: number | string): string => (typeof n === 'number' ? n.toFixed(2) : String(n));

/** Normalise any `YYYY-MM-DD` (or `YYYY-MM`) date to the first day of its month (`YYYY-MM-01`). */
function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

/** Thrown when a CP38 record is edited/terminated for a period that already has a processed payslip. */
export class Cp38PeriodProcessedError extends Error {
  constructor(public readonly period: string) {
    super(`CP38 cannot be changed for ${period}: that pay period is already processed.`);
    this.name = 'Cp38PeriodProcessedError';
  }
}

export type Cp38Row = {
  id: string;
  employmentId: string;
  cp38Ref: string;
  amount: string;
  validFrom: string;
  validTo: string | null;
  remarks: string | null;
  supersededAt: Date | null;
};

/** All CP38 rows (incl. superseded/closed) for an employment, latest-effective first. Read-only. */
export function listCp38(ctx: SessionContext, p: { employmentId: string }): Promise<Cp38Row[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: employeeCp38.id,
        employmentId: employeeCp38.employmentId,
        cp38Ref: employeeCp38.cp38Ref,
        amount: employeeCp38.amount,
        validFrom: employeeCp38.validFrom,
        validTo: employeeCp38.validTo,
        remarks: employeeCp38.remarks,
        supersededAt: employeeCp38.supersededAt,
      })
      .from(employeeCp38)
      .where(eq(employeeCp38.employmentId, p.employmentId))
      .orderBy(desc(employeeCp38.validFrom), desc(employeeCp38.id)),
  );
}

/**
 * Add a CP38 instruction (supersede-on-write). Normalises dates to month-start, validates `amount >= 0`
 * and `validFrom <= validTo`, closes the current open row so the new one cannot overlap, then inserts the
 * new effective-dated row. The gist EXCLUDE is the concurrency backstop. Appends `employee-cp38.added`.
 */
export function setCp38(
  ctx: SessionContext,
  p: {
    employmentId: string;
    cp38Ref: string;
    amount: number;
    validFrom: string;
    validTo?: string | null;
    remarks?: string | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    if (!(p.amount >= 0)) throw new Error('CP38 amount must be zero or positive.');
    const validFrom = monthStart(p.validFrom);
    const validTo = p.validTo ? monthStart(p.validTo) : null;
    if (validTo && validTo < validFrom) throw new Error('CP38 effective-to must not be before effective-from.');

    // Close the current open row for this employment so the new one does not overlap (matches setCompensation).
    const [cur] = await tx
      .select({ id: employeeCp38.id })
      .from(employeeCp38)
      .where(
        and(
          eq(employeeCp38.employmentId, p.employmentId),
          isNull(employeeCp38.validTo),
          isNull(employeeCp38.supersededAt),
        ),
      )
      .limit(1);
    if (cur) {
      await tx.update(employeeCp38).set({ validTo: validFrom }).where(eq(employeeCp38.id, cur.id));
    }
    const [row] = await tx
      .insert(employeeCp38)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        cp38Ref: p.cp38Ref,
        amount: money(p.amount),
        validFrom,
        validTo,
        remarks: p.remarks ?? null,
      })
      .returning({ id: employeeCp38.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-cp38',
      aggregateId: row.id,
      eventType: 'employee-cp38.added',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // ADR-0030 Layer 0: the amount lives on the aggregate row; the event keeps refs/dates only.
      payload: { employmentId: p.employmentId, cp38Ref: p.cp38Ref, validFrom, validTo },
    });
    return { id: row.id };
  });
}

/** Load a CP38 row (by id) for mutation, or throw if missing. */
async function loadCp38(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: employeeCp38.id,
      employmentId: employeeCp38.employmentId,
      cp38Ref: employeeCp38.cp38Ref,
      validFrom: employeeCp38.validFrom,
      validTo: employeeCp38.validTo,
      supersededAt: employeeCp38.supersededAt,
    })
    .from(employeeCp38)
    .where(eq(employeeCp38.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Guard: refuse to mutate a CP38 row if a NON-DRAFT payslip already exists for this employment in a month
 * the row covers. A payslip only exists once `generatePayslips` flips the batch to `processed`/`closed`,
 * so a non-draft batch == a processed period. The frozen payslip snapshot stays authoritative for CP39/EA;
 * the master record must not silently diverge from a month already filed.
 */
async function assertNoProcessedPeriod(
  tx: Tx,
  employmentId: string,
  validFrom: string,
  validTo: string | null,
): Promise<void> {
  const fromMonth = validFrom.slice(0, 7);
  const toMonth = validTo ? validTo.slice(0, 7) : null;
  const [hit] = await tx
    .select({ period: payrollBatch.payPeriod })
    .from(payslip)
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .where(
      and(
        eq(payslip.employmentId, employmentId),
        ne(payrollBatch.status, 'draft'),
        gte(payrollBatch.payPeriod, fromMonth),
        toMonth ? lte(payrollBatch.payPeriod, toMonth) : sql`true`,
      ),
    )
    .orderBy(payrollBatch.payPeriod)
    .limit(1);
  if (hit) throw new Cp38PeriodProcessedError(hit.period);
}

/**
 * Edit ref/amount/dates/remarks of a non-superseded CP38 row BEFORE processing. Throws
 * `Cp38PeriodProcessedError` if any month the (current or new) window covers is already processed.
 * Appends `employee-cp38.updated` with `{ before, after, diff }` (refs/dates only — no cleartext amount).
 */
export function updateCp38(
  ctx: SessionContext,
  p: {
    id: string;
    cp38Ref?: string;
    amount?: number;
    validFrom?: string;
    validTo?: string | null;
    remarks?: string | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadCp38(tx, p.id);
    if (!existing) throw new Error('CP38 record not found.');

    const nextFrom = p.validFrom !== undefined ? monthStart(p.validFrom) : existing.validFrom;
    const nextTo =
      p.validTo !== undefined ? (p.validTo ? monthStart(p.validTo) : null) : existing.validTo;
    if (p.amount !== undefined && !(p.amount >= 0)) throw new Error('CP38 amount must be zero or positive.');
    if (nextTo && nextTo < nextFrom) throw new Error('CP38 effective-to must not be before effective-from.');

    // Guard both the existing window and the proposed window — neither may touch a processed month.
    await assertNoProcessedPeriod(tx, existing.employmentId, existing.validFrom, existing.validTo);
    await assertNoProcessedPeriod(tx, existing.employmentId, nextFrom, nextTo);

    const patch: Record<string, unknown> = {};
    if (p.cp38Ref !== undefined) patch.cp38Ref = p.cp38Ref;
    if (p.amount !== undefined) patch.amount = money(p.amount);
    if (p.validFrom !== undefined) patch.validFrom = nextFrom;
    if (p.validTo !== undefined) patch.validTo = nextTo;
    if (p.remarks !== undefined) patch.remarks = p.remarks ?? null;
    if (Object.keys(patch).length > 0) {
      await tx.update(employeeCp38).set(patch).where(eq(employeeCp38.id, p.id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-cp38',
      aggregateId: p.id,
      eventType: 'employee-cp38.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      // Refs/dates only (ADR-0030 Layer 0): the diff names which fields changed, never the amount value.
      payload: {
        before: { cp38Ref: existing.cp38Ref, validFrom: existing.validFrom, validTo: existing.validTo },
        after: { cp38Ref: p.cp38Ref ?? existing.cp38Ref, validFrom: nextFrom, validTo: nextTo },
        diff: Object.keys(patch),
      },
    });
    return { id: p.id };
  });
}

/**
 * Terminate (close) an open CP38 row so it stops applying — soft, for audit reconcilability. Closes the
 * window at the current month and stamps `supersededAt`. Same processed-period guard as `updateCp38`.
 * Appends `employee-cp38.terminated`.
 */
export function terminateCp38(ctx: SessionContext, p: { id: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadCp38(tx, p.id);
    if (!existing) throw new Error('CP38 record not found.');
    await assertNoProcessedPeriod(tx, existing.employmentId, existing.validFrom, existing.validTo);

    const closeAt = monthStart(todayInKualaLumpur());
    // Don't reopen a window that already ended before this month; clamp validTo to the earlier bound.
    const validTo = existing.validTo && existing.validTo < closeAt ? existing.validTo : closeAt;
    await tx
      .update(employeeCp38)
      .set({ validTo, supersededAt: sql`now()` })
      .where(eq(employeeCp38.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-cp38',
      aggregateId: p.id,
      eventType: 'employee-cp38.terminated',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      payload: { employmentId: existing.employmentId, cp38Ref: existing.cp38Ref, validTo },
    });
    return { id: p.id };
  });
}

/** A raw CP38 window row matching a payroll month (no per-employment dedup applied). */
export type Cp38PeriodRow = { employmentId: string; amount: string; cp38Ref: string; validFrom: string };

/**
 * The RAW window query behind `cp38ForPeriod` (no dedup). `validTo` is treated as EXCLUSIVE to align with
 * the schema's `[)` daterange EXCLUDE constraint and with `setCp38`, which closes a superseded row at
 * `validTo = newValidFrom`: a row closed at the boundary month MUST NOT also match that same month as its
 * successor. Hence `gt(validTo, periodMonthStart)`, not `gte`. Ordered latest-effective first.
 */
export async function cp38RowsForPeriod(
  tx: Tx,
  empIds: string[],
  periodKey: string, // 'YYYY-MM'
): Promise<Cp38PeriodRow[]> {
  if (empIds.length === 0) return [];
  const periodMonthStart = `${periodKey}-01`;
  return tx
    .select({
      employmentId: employeeCp38.employmentId,
      amount: employeeCp38.amount,
      cp38Ref: employeeCp38.cp38Ref,
      validFrom: employeeCp38.validFrom,
    })
    .from(employeeCp38)
    .where(
      and(
        inArray(employeeCp38.employmentId, empIds),
        isNull(employeeCp38.supersededAt),
        lte(employeeCp38.validFrom, periodMonthStart),
        // EXCLUSIVE upper bound (gt, not gte): setCp38 closes a superseded row at validTo = newValidFrom and
        // the schema's gist EXCLUDE uses an exclusive `[)` daterange. With gte, the closed row and its
        // successor would BOTH match the boundary month (bug #34, masked today only by the first-per-row
        // dedup). gt aligns the predicate with the constraint so only the successor matches.
        or(isNull(employeeCp38.validTo), gt(employeeCp38.validTo, periodMonthStart)),
      ),
    )
    .orderBy(desc(employeeCp38.validFrom), desc(employeeCp38.id));
}

/**
 * Kernel helper — the CP38 instalment in effect for each employment in a payroll period (auto-apply by
 * payroll month). Selects rows whose month-aligned window covers the period's month, supersede-free, and
 * picks the latest-effective per employment (deterministic; overlap is structurally impossible). Call
 * INSIDE the generatePayslips transaction.
 */
export async function cp38ForPeriod(
  tx: Tx,
  empIds: string[],
  periodKey: string, // 'YYYY-MM'
): Promise<Map<string, { amount: number; cp38Ref: string }>> {
  const out = new Map<string, { amount: number; cp38Ref: string }>();
  if (empIds.length === 0) return out;
  const rows = await cp38RowsForPeriod(tx, empIds, periodKey);
  // First row per employment wins (latest valid_from) — overlap is impossible, so this is deterministic.
  for (const r of rows) {
    if (out.has(r.employmentId)) continue;
    out.set(r.employmentId, { amount: Number(r.amount), cp38Ref: r.cp38Ref });
  }
  return out;
}
