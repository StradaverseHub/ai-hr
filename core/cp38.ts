/**
 * 1.2.3 CP38 Deduction (ADR-0057) — an LHDN/court instalment deducted each payroll month IN ADDITION to
 * monthly MTD/PCB. Per-employment, effective-dated, supersede-on-write (mirrors `core/comp.ts`
 * setCompensation): adding a record CLOSES the open row (sets its end) and INSERTs a new row, so at most one
 * CP38 row applies to any given month. The Postgres gist EXCLUDE (`employee_cp38_no_overlap`, migration 0117)
 * is the backstop against a concurrent-write overlap — a silent duplicate garnishment is a compliance hazard,
 * so it must be structurally impossible, not merely app-checked.
 *
 * GRANULARITY — month-aligned. The feature is "by year and month". `validFrom`/`validTo` are stored as
 * `date` but every input is NORMALISED to the first day of its month (`YYYY-MM-01`); `cp38ForPeriod`
 * compares against the payroll period's month bucket. A mid-month instruction therefore charges the whole
 * month it starts in. (Documented in the admin form hint.)
 *
 * "EFFECTIVE TO" IS THE LAST MONTH DEDUCTED (bc6b5490, 26 Nov 2026). Storage stays EXCLUSIVE — the column holds
 * the first day AFTER the last charged month, which is what the gist rule's '[)' range, setCp38's closing at the
 * successor's start and the engine reader all mean — and this module is the one place that translates. Every
 * service input and every Cp38Row carries the INCLUSIVE last month the screens show and the operator types
 * (`validTo` = 'YYYY-MM-01' of the last deducted month, null = open-ended). Before this item the screens posted
 * the month they meant and the service stored it as the exclusive end, so "January to July" stopped after June and
 * a one-month record was never deducted. Rows already stored that way are listed, and moved only on the owner's
 * confirmation, by scripts/cp38-inclusive-effective-to-bc6b5490.ts.
 *
 * CORRECTIONS ARE ALWAYS ALLOWED (bc6b5490, superseding 038c304b's "locked once a closed payroll used it" and the
 * former processed-period refusal). Closed payrolls are protected by never being recalculated, not by refusing
 * the edit: every add, edit, end and delete marks the processed (not closed) runs whose month the old or the new
 * window covers as Reprocess Required (124a979e, category 'cp38'), and the reprocess reads the corrected record.
 * Each edit and delete appends one row to `employee_cp38_revision` with the values before and after.
 *
 * WHO. Every write resolves the record to its employment and refuses unless the caller administers payroll for the
 * employment's company (`app.can_admin_payroll_for`) and, when the screen passes its company-switcher scope,
 * that company is in it — so the company-wide page cannot change another company's row by id (038c304b).
 *
 * LOCKS (as fixed items): the shared Access lock, then the employee's payroll inputs key, then rows — a change
 * either commits before a run reads its inputs or waits for the run and then marks it.
 *
 * Substrate discipline (ADR-0006 / ADR-0030 Layer 0): every write appends a DomainEvent whose payload
 * carries references + dates only — never the cleartext CP38 amount, which lives on the aggregate row and,
 * for corrections, on the row-secured revision.
 */
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../db/client';
import { withPayrollHistoryTenant as withTenant } from './payroll-history-lock';
import { actorOf, appendEvent } from '../db/events';
import { employeeCp38, employeeCp38Revision } from '../db/schema';
import { uuidArrayParam } from '../db/sql-arrays';
import { lockAccessConfigurationTx } from './access-configuration-lock';
import { lockPayrollInputsTx } from './payroll-inputs-lock';
import { cappedTotal, keysetReadLimit, keysetSlice, listCountCap, type KeysetPageQuery, type KeysetRead } from '../lib/pagination';

import { todayInKualaLumpur } from '../lib/hr-date';

const money = (n: number | string): string => (typeof n === 'number' ? n.toFixed(2) : String(n));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_INPUT = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;

/** Normalise any `YYYY-MM-DD` (or `YYYY-MM`) date to the first day of its month (`YYYY-MM-01`). */
function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}
/** The first day of the month `delta` months from `month` ('YYYY-MM-01'). */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 10);
}
/** Stored exclusive end → the inclusive last month a screen shows (null = open-ended). */
export function cp38LastMonthOf(storedValidTo: string | null): string | null {
  return storedValidTo ? shiftMonth(storedValidTo, -1) : null;
}
/** The inclusive last month an operator enters → the stored exclusive end (the first day of the next month). */
export function cp38StoredValidTo(lastMonth: string | null): string | null {
  return lastMonth ? shiftMonth(monthStart(lastMonth), 1) : null;
}

/** A refused input, named so each screen can say which field is wrong. */
export type Cp38InputProblem = 'refRequired' | 'amount' | 'lastMonthAmount' | 'lastMonthNeedsEnd' | 'backwards' | 'date';
export class Cp38InputError extends Error {
  constructor(public readonly problem: Cp38InputProblem) {
    super(`CP38 input refused: ${problem}.`);
    this.name = 'Cp38InputError';
  }
}
/** The window would overlap another current CP38 record of the same employee (named, instead of the gist error). */
export class Cp38OverlapError extends Error {
  constructor(
    public readonly cp38Ref: string,
    public readonly validFrom: string,
    /** The clashing record's inclusive last month, null when open-ended. */
    public readonly validTo: string | null,
  ) {
    super(`CP38 overlaps record ${cp38Ref} from ${validFrom}${validTo ? ` to ${validTo}` : ''}.`);
    this.name = 'Cp38OverlapError';
  }
}
export class Cp38NotFoundError extends Error {
  constructor() {
    super('CP38 record not found.');
    this.name = 'Cp38NotFoundError';
  }
}
/** The employee is not one whose payroll this session administers (or is outside the screen's company scope). */
export class Cp38OutOfScopeError extends Error {
  constructor() {
    super('CP38 is managed by a payroll administrator of the employee’s company.');
    this.name = 'Cp38OutOfScopeError';
  }
}
/** End now asked of a record that has not been deducted yet: there is nothing to end, Delete removes it. */
export class Cp38NotStartedError extends Error {
  constructor(public readonly validFrom: string) {
    super(`CP38 starts ${validFrom}; delete it instead of ending it.`);
    this.name = 'Cp38NotStartedError';
  }
}

export type Cp38Row = {
  id: string;
  employmentId: string;
  cp38Ref: string;
  amount: string;
  /** The last charged month's instalment; null = `amount` throughout. */
  lastMonthAmount: string | null;
  validFrom: string;
  /** INCLUSIVE last deducted month ('YYYY-MM-01'), null = open-ended. */
  validTo: string | null;
  remarks: string | null;
  /** Set when the record was deleted (or, before bc6b5490, terminated): it applies to no payroll. */
  supersededAt: Date | null;
};

/** The values a correction-history row records before and after (amounts included; row-secured). */
export type Cp38Values = Pick<Cp38Row, 'cp38Ref' | 'amount' | 'lastMonthAmount' | 'validFrom' | 'validTo' | 'remarks'>;

const ROW_COLUMNS = {
  id: employeeCp38.id,
  employmentId: employeeCp38.employmentId,
  cp38Ref: employeeCp38.cp38Ref,
  amount: employeeCp38.amount,
  lastMonthAmount: employeeCp38.lastMonthAmount,
  validFrom: employeeCp38.validFrom,
  validTo: employeeCp38.validTo,
  remarks: employeeCp38.remarks,
  supersededAt: employeeCp38.supersededAt,
};
type StoredRow = { [K in keyof typeof ROW_COLUMNS]: Cp38Row[K] };
const toRow = (r: StoredRow): Cp38Row => ({ ...r, validTo: cp38LastMonthOf(r.validTo) });
const valuesOf = (r: Cp38Row): Cp38Values => ({
  cp38Ref: r.cp38Ref,
  amount: money(r.amount),
  lastMonthAmount: r.lastMonthAmount == null ? null : money(r.lastMonthAmount),
  validFrom: r.validFrom,
  validTo: r.validTo,
  remarks: r.remarks,
});

/** All CP38 rows (incl. deleted ones, `supersededAt` set) for an employment, latest-effective first. Read-only. */
export function listCp38(ctx: SessionContext, p: { employmentId: string }): Promise<Cp38Row[]> {
  return withTenant(ctx, async (tx) =>
    (
      await tx
        .select(ROW_COLUMNS)
        .from(employeeCp38)
        .where(eq(employeeCp38.employmentId, p.employmentId))
        .orderBy(desc(employeeCp38.validFrom), desc(employeeCp38.id))
    ).map(toRow),
  );
}

/** Validate and normalise the editable values. Throws Cp38InputError naming the field. */
function normalise(v: {
  cp38Ref: string;
  amount: number;
  lastMonthAmount: number | null;
  validFrom: string;
  validTo: string | null;
  remarks: string | null;
}): Cp38Values & { storedTo: string | null } {
  const cp38Ref = v.cp38Ref.trim();
  if (!cp38Ref) throw new Cp38InputError('refRequired');
  if (!(Number.isFinite(v.amount) && v.amount >= 0)) throw new Cp38InputError('amount');
  if (!MONTH_INPUT.test(v.validFrom) || (v.validTo != null && !MONTH_INPUT.test(v.validTo))) throw new Cp38InputError('date');
  const validFrom = monthStart(v.validFrom);
  const validTo = v.validTo ? monthStart(v.validTo) : null;
  if (validTo && validTo < validFrom) throw new Cp38InputError('backwards');
  if (v.lastMonthAmount != null) {
    if (!(Number.isFinite(v.lastMonthAmount) && v.lastMonthAmount >= 0)) throw new Cp38InputError('lastMonthAmount');
    // The last-month amount is for the last month, so there has to be one (the 7540 CHECK says the same).
    if (!validTo) throw new Cp38InputError('lastMonthNeedsEnd');
  }
  return {
    cp38Ref,
    amount: money(v.amount),
    lastMonthAmount: v.lastMonthAmount == null ? null : money(v.lastMonthAmount),
    validFrom,
    validTo,
    remarks: v.remarks?.trim() ? v.remarks.trim() : null,
    storedTo: cp38StoredValidTo(validTo),
  };
}

/**
 * Shared Access lock, the payroll-administration check of the employment's company, then the employee's payroll
 * inputs key (the fixed-item order). The check reads the employment under the caller's own row security, so an
 * employee the caller cannot see is refused the same way as one whose payroll they do not administer.
 */
async function openWriteTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  companyIds: readonly string[] | undefined,
): Promise<void> {
  if (!UUID.test(employmentId)) throw new Cp38OutOfScopeError();
  const [row] = await tx.execute<{ companyId: string; payrollAdmin: boolean }>(sql`
    select e.company_id as "companyId", app.can_admin_payroll_for(e.company_id) as "payrollAdmin"
    from employment e where e.id = ${employmentId}::uuid and e.tenant_id = ${ctx.tenantId}::uuid`);
  if (!row || row.payrollAdmin !== true || (companyIds && !companyIds.includes(row.companyId))) {
    throw new Cp38OutOfScopeError();
  }
  await lockPayrollInputsTx(tx, { employmentIds: [employmentId] });
}

/** Load a current (not deleted) CP38 row by id for mutation, under the Access lock, scope check and row lock. */
async function loadForWriteTx(
  tx: Tx,
  ctx: SessionContext,
  id: string,
  companyIds: readonly string[] | undefined,
): Promise<Cp38Row> {
  if (!UUID.test(id)) throw new Cp38NotFoundError();
  await lockAccessConfigurationTx(tx, ctx.tenantId);
  const [probe] = await tx
    .select({ employmentId: employeeCp38.employmentId })
    .from(employeeCp38)
    .where(and(eq(employeeCp38.id, id), isNull(employeeCp38.supersededAt)))
    .limit(1);
  if (!probe) throw new Cp38NotFoundError();
  await openWriteTx(tx, ctx, probe.employmentId, companyIds);
  const [row] = await tx
    .select(ROW_COLUMNS)
    .from(employeeCp38)
    .where(and(eq(employeeCp38.id, id), isNull(employeeCp38.supersededAt)))
    .for('update')
    .limit(1);
  if (!row) throw new Cp38NotFoundError();
  return toRow(row);
}

/** Refuse a window that overlaps another current record of the employee, naming it (the gist rule stays the backstop). */
async function assertNoOverlapTx(
  tx: Tx,
  employmentId: string,
  from: string,
  storedTo: string | null,
  exceptIds: readonly string[],
): Promise<void> {
  const [hit] = await tx.execute<{ cp38Ref: string; validFrom: string; validTo: string | null }>(sql`
    select cp38_ref as "cp38Ref", valid_from::text as "validFrom", valid_to::text as "validTo"
    from employee_cp38
    where employment_id = ${employmentId}::uuid and superseded_at is null
      and not (id = any(${uuidArrayParam(exceptIds)}))
      and daterange(valid_from, valid_to, '[)') && daterange(${from}::date, ${storedTo}::date, '[)')
    order by valid_from limit 1`);
  if (hit) throw new Cp38OverlapError(hit.cp38Ref, hit.validFrom, cp38LastMonthOf(hit.validTo));
}

/** A concurrent writer won the race the pre-check could not see: the gist rule's 23P01, said as an overlap. */
function isExclusionViolation(e: unknown): boolean {
  const code = (x: unknown) => (x && typeof x === 'object' ? (x as { code?: unknown }).code : undefined);
  return code(e) === '23P01' || code((e as { cause?: unknown })?.cause) === '23P01';
}

async function appendRevisionTx(
  tx: Tx,
  ctx: SessionContext,
  p: { cp38Id: string; employmentId: string; action: 'edit' | 'delete'; before: Cp38Values; after: Cp38Values | null },
): Promise<void> {
  await tx.insert(employeeCp38Revision).values({
    tenantId: ctx.tenantId,
    cp38Id: p.cp38Id,
    employmentId: p.employmentId,
    action: p.action,
    before: p.before,
    after: p.after,
    actorUserId: ctx.userId && UUID.test(ctx.userId) ? ctx.userId : null,
  });
}

/**
 * 124a979e / 038c304b — the processed (not closed) runs that paid this employee for a month either window covers
 * become Reprocess Required. One indexed read of the employee's payslips (markRunsAffectedByEmploymentChangeTx skips
 * closed runs and runs the caller does not administer). Windows are stored-form: `to` exclusive, null = open-ended.
 * Lazy import: core/payroll imports this module for cp38ForPeriod.
 */
async function markWindowsTx(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  windows: readonly { from: string; to: string | null }[],
): Promise<void> {
  if (windows.length === 0) return;
  const from = windows.map((w) => w.from).sort()[0];
  const until = windows.some((w) => w.to == null) ? null : windows.map((w) => w.to as string).sort().at(-1)!;
  const { markRunsAffectedByEmploymentChangeTx } = await import('./payroll');
  await markRunsAffectedByEmploymentChangeTx(tx, ctx, { employmentIds: [employmentId], category: 'cp38', from, until });
}

/** Optional on every write: the screen's company-switcher scope; a record outside it is refused. */
type ScopeOption = { companyIds?: readonly string[] };

/**
 * Add a CP38 instruction (supersede-on-write). Validates, closes the current open row at the new record's first
 * month (a revision row records that change), refuses a start at or before the open row's start and any other
 * overlap with a named error, inserts the new row and marks the affected processed runs. `validTo` is the
 * INCLUSIVE last month. Appends `employee-cp38.added`.
 */
export function setCp38(
  ctx: SessionContext,
  p: {
    employmentId: string;
    cp38Ref: string;
    amount: number;
    lastMonthAmount?: number | null;
    validFrom: string;
    validTo?: string | null;
    remarks?: string | null;
  } & ScopeOption,
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const v = normalise({
      cp38Ref: p.cp38Ref,
      amount: p.amount,
      lastMonthAmount: p.lastMonthAmount ?? null,
      validFrom: p.validFrom,
      validTo: p.validTo ?? null,
      remarks: p.remarks ?? null,
    });
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    await openWriteTx(tx, ctx, p.employmentId, p.companyIds);

    // The current open row is closed at the new start so the two cannot overlap (matches setCompensation). A start
    // at or before the open row's own start would leave it an empty window: refused by name, not by the database.
    const [openStored] = await tx
      .select(ROW_COLUMNS)
      .from(employeeCp38)
      .where(and(eq(employeeCp38.employmentId, p.employmentId), isNull(employeeCp38.validTo), isNull(employeeCp38.supersededAt)))
      .for('update')
      .limit(1);
    const open = openStored ? toRow(openStored) : null;
    if (open && v.validFrom <= open.validFrom) throw new Cp38OverlapError(open.cp38Ref, open.validFrom, null);
    await assertNoOverlapTx(tx, p.employmentId, v.validFrom, v.storedTo, open ? [open.id] : []);

    try {
      if (open) {
        await tx.update(employeeCp38).set({ validTo: v.validFrom }).where(eq(employeeCp38.id, open.id));
        await appendRevisionTx(tx, ctx, {
          cp38Id: open.id,
          employmentId: p.employmentId,
          action: 'edit',
          before: valuesOf(open),
          after: { ...valuesOf(open), validTo: cp38LastMonthOf(v.validFrom) },
        });
      }
      const [row] = await tx
        .insert(employeeCp38)
        .values({
          tenantId: ctx.tenantId,
          employmentId: p.employmentId,
          cp38Ref: v.cp38Ref,
          amount: v.amount,
          lastMonthAmount: v.lastMonthAmount,
          validFrom: v.validFrom,
          validTo: v.storedTo,
          remarks: v.remarks,
        })
        .returning({ id: employeeCp38.id });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'employee-cp38',
        aggregateId: row.id,
        eventType: 'employee-cp38.added',
        actor: actorOf(ctx),
        subjectEmploymentId: p.employmentId,
        // ADR-0030 Layer 0: the amount lives on the aggregate row; the event keeps refs/dates only (validTo is
        // the inclusive last month, as every Cp38Row carries it).
        payload: { employmentId: p.employmentId, cp38Ref: v.cp38Ref, validFrom: v.validFrom, validTo: v.validTo },
      });
      // The new window, and (when an open row was closed) the months it no longer covers: from the new start on.
      await markWindowsTx(tx, ctx, p.employmentId, [{ from: v.validFrom, to: open ? null : v.storedTo }]);
      return { id: row.id };
    } catch (e) {
      if (isExclusionViolation(e)) throw new Cp38OverlapError(v.cp38Ref, v.validFrom, v.validTo);
      throw e;
    }
  });
}

/**
 * Edit any of reference, monthly amount, last-month amount, Effective from, Effective to (INCLUSIVE last month) and
 * remarks of a current CP38 record, in place — whatever payroll used it (bc6b5490). Nothing changed writes nothing.
 * Otherwise: one revision row (before/after), `employee-cp38.updated` (refs/dates and the CHANGED FIELD NAMES only),
 * and, when a pay-affecting field moved, the processed runs of the union of the old and new windows are marked.
 */
export function updateCp38(
  ctx: SessionContext,
  p: {
    id: string;
    cp38Ref?: string;
    amount?: number;
    lastMonthAmount?: number | null;
    validFrom?: string;
    validTo?: string | null;
    remarks?: string | null;
  } & ScopeOption,
): Promise<{ id: string; changed: boolean }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadForWriteTx(tx, ctx, p.id, p.companyIds);
    const v = normalise({
      cp38Ref: p.cp38Ref ?? existing.cp38Ref,
      amount: p.amount ?? Number(existing.amount),
      lastMonthAmount:
        p.lastMonthAmount !== undefined
          ? p.lastMonthAmount
          : existing.lastMonthAmount == null
            ? null
            : Number(existing.lastMonthAmount),
      validFrom: p.validFrom ?? existing.validFrom,
      validTo: p.validTo !== undefined ? p.validTo : existing.validTo,
      remarks: p.remarks !== undefined ? p.remarks : existing.remarks,
    });
    const { storedTo, ...after } = v;
    const before = valuesOf(existing);
    const diff = (Object.keys(after) as (keyof Cp38Values)[]).filter((k) => after[k] !== before[k]);
    if (diff.length === 0) return { id: p.id, changed: false };

    await assertNoOverlapTx(tx, existing.employmentId, v.validFrom, storedTo, [existing.id]);
    try {
      await tx
        .update(employeeCp38)
        .set({
          cp38Ref: v.cp38Ref,
          amount: v.amount,
          lastMonthAmount: v.lastMonthAmount,
          validFrom: v.validFrom,
          validTo: storedTo,
          remarks: v.remarks,
        })
        .where(eq(employeeCp38.id, existing.id));
    } catch (e) {
      if (isExclusionViolation(e)) throw new Cp38OverlapError(v.cp38Ref, v.validFrom, v.validTo);
      throw e;
    }
    await appendRevisionTx(tx, ctx, { cp38Id: existing.id, employmentId: existing.employmentId, action: 'edit', before, after });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-cp38',
      aggregateId: p.id,
      eventType: 'employee-cp38.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      // Refs/dates only (ADR-0030 Layer 0): the diff names which fields changed, never the amount value — the
      // values before and after are on the row-secured revision.
      payload: {
        before: { cp38Ref: before.cp38Ref, validFrom: before.validFrom, validTo: before.validTo },
        after: { cp38Ref: after.cp38Ref, validFrom: after.validFrom, validTo: after.validTo },
        diff,
      },
    });
    // Remarks are not read by payroll; every other field is (the reference is printed on the payslip and CP39).
    if (diff.some((k) => k !== 'remarks')) {
      await markWindowsTx(tx, ctx, existing.employmentId, [
        { from: existing.validFrom, to: cp38StoredValidTo(existing.validTo) },
        { from: v.validFrom, to: storedTo },
      ]);
    }
    return { id: p.id, changed: true };
  });
}

/**
 * End now: the record's last deducted month becomes the month before this one (the Kuala Lumpur calendar), the
 * Personnel tab's Terminate. Since bc6b5490 it only sets Effective to — it no longer also stamps `supersededAt`,
 * which made the record vanish from every payroll including earlier months not yet closed. A record already ended by
 * then is left alone; one that has not started is refused (Delete removes it). A last-month amount is cleared: it
 * belonged to the original final instalment. Revision, event and marks as an edit; appends `employee-cp38.terminated`.
 */
export function terminateCp38(ctx: SessionContext, p: { id: string } & ScopeOption): Promise<{ id: string; changed: boolean }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadForWriteTx(tx, ctx, p.id, p.companyIds);
    const closeAt = monthStart(todayInKualaLumpur());
    const storedTo = cp38StoredValidTo(existing.validTo);
    if (storedTo && storedTo <= closeAt) return { id: p.id, changed: false };
    if (existing.validFrom >= closeAt) throw new Cp38NotStartedError(existing.validFrom);
    await tx.update(employeeCp38).set({ validTo: closeAt, lastMonthAmount: null }).where(eq(employeeCp38.id, p.id));
    const before = valuesOf(existing);
    const after: Cp38Values = { ...before, validTo: cp38LastMonthOf(closeAt), lastMonthAmount: null };
    await appendRevisionTx(tx, ctx, { cp38Id: existing.id, employmentId: existing.employmentId, action: 'edit', before, after });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-cp38',
      aggregateId: p.id,
      eventType: 'employee-cp38.terminated',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      payload: { employmentId: existing.employmentId, cp38Ref: existing.cp38Ref, validTo: after.validTo },
    });
    await markWindowsTx(tx, ctx, existing.employmentId, [{ from: closeAt, to: storedTo }]);
    return { id: p.id, changed: true };
  });
}

/**
 * 038c304b / bc6b5490 — Delete: the record stops applying to every payroll that is not closed and leaves both screens.
 * No hard delete: `superseded_at` is set (every reader and the gist rule ignore the row), a 'delete' revision keeps
 * its values, and `employee-cp38.deleted` (refs/dates only) records who removed it. Marks the processed runs of its
 * window. Closed payslips keep what they deducted.
 */
export function deleteCp38(ctx: SessionContext, p: { id: string } & ScopeOption): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadForWriteTx(tx, ctx, p.id, p.companyIds);
    await tx.update(employeeCp38).set({ supersededAt: sql`now()` }).where(eq(employeeCp38.id, p.id));
    await appendRevisionTx(tx, ctx, {
      cp38Id: existing.id,
      employmentId: existing.employmentId,
      action: 'delete',
      before: valuesOf(existing),
      after: null,
    });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-cp38',
      aggregateId: p.id,
      eventType: 'employee-cp38.deleted',
      actor: actorOf(ctx),
      subjectEmploymentId: existing.employmentId,
      payload: {
        employmentId: existing.employmentId,
        cp38Ref: existing.cp38Ref,
        validFrom: existing.validFrom,
        validTo: existing.validTo,
      },
    });
    await markWindowsTx(tx, ctx, existing.employmentId, [{ from: existing.validFrom, to: cp38StoredValidTo(existing.validTo) }]);
    return { id: p.id };
  });
}

// ── Readers for the screens ───────────────────────────────────────────────────────────────────────────────

/** Active (deducting this month), Upcoming (starts later) or Ended (its last month is before this one). */
export type Cp38Status = 'active' | 'upcoming' | 'ended';
export const CP38_STATUSES: readonly Cp38Status[] = ['active', 'upcoming', 'ended'];

/** The status of a row against a month ('YYYY-MM-01'), from the same stored bounds the list filters by. */
export function cp38StatusOf(r: Pick<Cp38Row, 'validFrom' | 'validTo'>, thisMonth: string): Cp38Status {
  if (r.validFrom > thisMonth) return 'upcoming';
  return r.validTo != null && r.validTo < thisMonth ? 'ended' : 'active';
}

export type Cp38ListRow = Cp38Row & {
  employeeCode: string | null;
  employeeName: string;
  companyId: string;
  company: string;
  status: Cp38Status;
};

/**
 * 038c304b — every current CP38 record of the given companies, for the Payroll > Transaction Entry > CP38 Deduction
 * page. One set-based read per concern (rows, then a bounded count), whatever the number of companies:
 *  - population: current (not deleted) records of non-voided employments whose company is in `companyIds` (one
 *    uuid[] parameter) AND administered for payroll by the session (the company semi-join evaluates
 *    app.can_admin_payroll_for once per company, never per row), under the session's own row security; leavers
 *    included (038c304b: history stays visible), optionally one employment and one status against this month;
 *  - order and keyset: (company name, employee code, Effective from, id), continuing after or before an anchor
 *    record read with the same key; an anchor no longer in the list serves the first page;
 *  - count: exact up to the list cap, then "1,000+" (cappedTotal), exact on request.
 */
export async function listCp38Across(
  ctx: SessionContext,
  p: {
    companyIds: readonly string[];
    employmentId?: string | null;
    status?: Cp38Status | null;
    today?: string;
    page: Pick<KeysetPageQuery, 'limit' | 'after' | 'before' | 'last' | 'exactCount' | 'size'>;
  },
): Promise<{ rows: Cp38ListRow[] } & KeysetRead> {
  const thisMonth = monthStart(p.today ?? todayInKualaLumpur());
  const companies = uuidArrayParam(p.companyIds);
  const employmentId = p.employmentId && UUID.test(p.employmentId) ? p.employmentId : null;
  const statusSql =
    p.status === 'active'
      ? sql`and r.valid_from <= ${thisMonth}::date and (r.valid_to is null or r.valid_to > ${thisMonth}::date)`
      : p.status === 'upcoming'
        ? sql`and r.valid_from > ${thisMonth}::date`
        : p.status === 'ended'
          ? sql`and r.valid_to <= ${thisMonth}::date`
          : sql``;
  const population = sql`
    from employee_cp38 r
    join employment e on e.id = r.employment_id and e.tenant_id = r.tenant_id
    join person pe on pe.id = e.person_id and pe.tenant_id = e.tenant_id
    join company c on c.id = e.company_id and c.tenant_id = e.tenant_id
    where r.superseded_at is null and e.voided_at is null
      and e.company_id in (select pc.id from company pc where pc.id = any(${companies}) and app.can_admin_payroll_for(pc.id))
      ${employmentId ? sql`and r.employment_id = ${employmentId}::uuid` : sql``}
      ${statusSql}`;
  const key = sql`(c.legal_name, coalesce(e.employee_code, ''), r.valid_from, r.id)`;
  const anchor = (id: string) => sql`(select ac.legal_name, coalesce(ae.employee_code, ''), ar.valid_from, ar.id
    from employee_cp38 ar join employment ae on ae.id = ar.employment_id join company ac on ac.id = ae.company_id
    where ar.id = ${id}::uuid and ar.superseded_at is null)`;
  type Fetched = StoredRow & { employeeCode: string | null; employeeName: string; companyId: string; company: string };
  return withTenant(
    ctx,
    async (tx) => {
      const read = async (cursor: Pick<KeysetPageQuery, 'after' | 'before' | 'last'>) => {
        const backwards = cursor.before !== undefined || cursor.last;
        const seek = cursor.after ? sql`and ${key} > ${anchor(cursor.after)}` : cursor.before ? sql`and ${key} < ${anchor(cursor.before)}` : sql``;
        const order = backwards
          ? sql`c.legal_name desc, coalesce(e.employee_code, '') desc, r.valid_from desc, r.id desc`
          : sql`c.legal_name, coalesce(e.employee_code, ''), r.valid_from, r.id`;
        return Array.from(
          await tx.execute<Fetched>(sql`select r.id, r.employment_id as "employmentId", r.cp38_ref as "cp38Ref",
              r.amount::text as amount, r.last_month_amount::text as "lastMonthAmount", r.valid_from::text as "validFrom",
              r.valid_to::text as "validTo", r.remarks, r.superseded_at as "supersededAt",
              e.employee_code as "employeeCode", pe.full_name as "employeeName", c.id as "companyId", c.legal_name as company
            ${population} ${seek} order by ${order} limit ${keysetReadLimit(p.page)}`),
        );
      };
      const cursor = { after: p.page.after, before: p.page.before, last: p.page.last };
      let fetched = await read(cursor);
      let anchorFound = true;
      if (fetched.length === 0 && (p.page.after || p.page.before)) {
        anchorFound = false;
        fetched = await read({ last: false });
      }
      const page = keysetSlice(fetched, { ...(anchorFound ? cursor : { last: false }), limit: p.page.limit }, anchorFound);
      const cap = listCountCap(p.page.size);
      const [counted] = await tx.execute<{ n: number }>(
        p.page.exactCount
          ? sql`select count(*)::int as n ${population}`
          : sql`select count(*)::int as n from (select 1 ${population} limit ${cap + 1}) bounded`,
      );
      const rows = page.rows.map((r): Cp38ListRow => {
        const row = toRow(r);
        return { ...row, employeeCode: r.employeeCode, employeeName: r.employeeName, companyId: r.companyId, company: r.company, status: cp38StatusOf(row, thisMonth) };
      });
      return { rows, total: cappedTotal(Number(counted?.n ?? 0), cap, p.page.exactCount), hasPrev: page.hasPrev, hasNext: page.hasNext, anchorFound };
    },
    { readOnlySnapshot: true },
  );
}

export type Cp38Revision = {
  id: string;
  cp38Id: string;
  employmentId: string;
  action: 'edit' | 'delete';
  before: Cp38Values;
  after: Cp38Values | null;
  /** Who made the change (their name), null when the user has no person record or it was a system/data step. */
  actorName: string | null;
  /** A signed-in user made it (false: a system or data step, e.g. scripts/cp38-inclusive-effective-to-bc6b5490.ts). */
  byUser: boolean;
  at: Date;
};

/** Most history rows one read returns (a screen shows one employee's or one page's records). */
export const CP38_REVISION_LIMIT = 500;

/**
 * bc6b5490 — the correction history of some CP38 records (`cp38Ids`, e.g. the rows of one list page) or of one
 * employee (`employmentId`, which includes deleted records), newest first, in one statement under the session's
 * row security (the revision is readable exactly where the employee's CP38 is). Bounded by CP38_REVISION_LIMIT.
 */
export function listCp38Revisions(
  ctx: SessionContext,
  p: { cp38Ids?: readonly string[]; employmentId?: string | null },
): Promise<Cp38Revision[]> {
  const ids = (p.cp38Ids ?? []).filter((id) => UUID.test(id));
  const employmentId = p.employmentId && UUID.test(p.employmentId) ? p.employmentId : null;
  if (ids.length === 0 && !employmentId) return Promise.resolve([]);
  return withTenant(
    ctx,
    async (tx) =>
      Array.from(
        await tx.execute<Cp38Revision>(sql`select v.id, v.cp38_id as "cp38Id", v.employment_id as "employmentId", v.action,
            v.before, v.after, ap.full_name as "actorName", (v.actor_user_id is not null) as "byUser", v.at
          from employee_cp38_revision v
          left join app_user au on au.id = v.actor_user_id
          left join person ap on ap.id = au.person_id
          where ${employmentId ? sql`v.employment_id = ${employmentId}::uuid` : sql`v.cp38_id = any(${uuidArrayParam(ids)})`}
          order by v.at desc, v.id desc limit ${CP38_REVISION_LIMIT}`),
      ).map((r) => ({
        ...r,
        // The raw driver may hand jsonb and timestamptz back as text; the screens get objects and a Date.
        before: (typeof r.before === 'string' ? JSON.parse(r.before) : r.before) as Cp38Values,
        after: (typeof r.after === 'string' ? JSON.parse(r.after) : r.after) as Cp38Values | null,
        at: r.at instanceof Date ? r.at : new Date(r.at),
      })),
    { readOnlySnapshot: true },
  );
}

// ── The engine reader ─────────────────────────────────────────────────────────────────────────────────────

/** A raw CP38 window row matching a payroll month (no per-employment dedup applied). `validTo` is STORED (exclusive). */
export type Cp38PeriodRow = {
  employmentId: string;
  amount: string;
  lastMonthAmount: string | null;
  cp38Ref: string;
  validFrom: string;
  validTo: string | null;
};

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
      lastMonthAmount: employeeCp38.lastMonthAmount,
      cp38Ref: employeeCp38.cp38Ref,
      validFrom: employeeCp38.validFrom,
      validTo: employeeCp38.validTo,
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

/** The instalment a row charges in a month: the last-month amount in its last charged month, else the monthly amount. */
export function cp38AmountForMonth(r: Pick<Cp38PeriodRow, 'amount' | 'lastMonthAmount' | 'validTo'>, periodKey: string): number {
  const last = cp38LastMonthOf(r.validTo);
  return r.lastMonthAmount != null && last != null && last.slice(0, 7) === periodKey ? Number(r.lastMonthAmount) : Number(r.amount);
}

/**
 * Kernel helper — the CP38 instalment in effect for each employment in a payroll period (auto-apply by
 * payroll month). Selects rows whose month-aligned window covers the period's month, supersede-free, and
 * picks the latest-effective per employment (deterministic; overlap is structurally impossible). In the record's
 * last charged month a last-month amount replaces the monthly one (bc6b5490). Call INSIDE the generatePayslips
 * transaction.
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
    out.set(r.employmentId, { amount: cp38AmountForMonth(r, periodKey), cp38Ref: r.cp38Ref });
  }
  return out;
}
