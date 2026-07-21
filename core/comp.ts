/**
 * Compensation — generic, jurisdiction-neutral, effective-dated (ADR-0008 #5).
 * Salary is comp *history*: a change CLOSE + INSERTs a new version. Amounts are tenant data.
 */
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { appUser, compensation, domainEvent, payrollBatch, payslip, person, tenantCounter } from '../db/schema';

const money = (n: number | string): string => (typeof n === 'number' ? n.toFixed(2) : String(n));

/** First day of the month AFTER a 'YYYY-MM' pay period — the exclusive end of its date range. */
const nextMonthStart = (period: string): string => {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

/**
 * Does the date window [from, to) (to = null ⇒ open-ended) overlap any of the given CLOSED 'YYYY-MM'
 * payroll periods? Pure helper shared by the delete/date-edit guards and the page's per-row "deletable"
 * flag, so the UI affordance and the service rule cannot drift apart. Date strings compare lexically.
 */
export function overlapsClosedPeriod(closedPeriods: string[], from: string, to: string | null): boolean {
  return closedPeriods.some((p) => `${p}-01` < (to ?? '9999-12-31') && from < nextMonthStart(p));
}

/** 'YYYY-MM' periods of CLOSED payroll batches that produced a payslip for this employment (tx-level). */
async function closedPeriodsTx(tx: Tx, employmentId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ period: payrollBatch.payPeriod })
    .from(payslip)
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .where(and(eq(payslip.employmentId, employmentId), eq(payrollBatch.status, 'closed')));
  return rows.map((r) => r.period);
}

/**
 * 'YYYY-MM' periods of CLOSED payroll runs that paid this employment. The Basic Salary card uses this
 * (with `overlapsClosedPeriod`) to decide which history rows are deletable — a record whose window a
 * closed run relied on is payroll evidence and must stay.
 */
export function closedPayrollPeriodsFor(ctx: SessionContext, employmentId: string): Promise<string[]> {
  return withTenant(ctx, (tx) => closedPeriodsTx(tx, employmentId));
}

export async function setCompensation(
  ctx: SessionContext,
  p: {
    employmentId: string;
    basicSalary: number;
    currency?: string;
    /** Omit to CARRY FORWARD the current record's allowance — a basic-salary-only revision must NOT wipe
     *  the monthly allowance (it feeds the OT ORP wage basis). Pass an explicit number (including 0) to set
     *  it; import / backfill paths pass explicit values. Allowances are now maintained via Pay Components. */
    monthlyAllowance?: number;
    /** Free-text reason for the change (Basic Salary screen, feedback 87c82b18). */
    remarks?: string;
    effectiveFrom: string;
  },
  /** Optional caller transaction — pass it to make this write participate in an enclosing
   *  transaction (e.g. the performance pay-seam enact) so it commits/rolls back atomically. */
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
    const [cur] = await tx
      .select()
      .from(compensation)
      .where(
        and(
          eq(compensation.employmentId, p.employmentId),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .limit(1);
    if (cur) {
      await tx.update(compensation).set({ validTo: p.effectiveFrom }).where(eq(compensation.id, cur.id));
    }
    // Carry-forward semantics: undefined allowance keeps the prior figure (or 0 for a brand-new record);
    // an explicit value (incl. 0) sets it. This stops a basic-only revision from silently zeroing allowance.
    const allowanceProvided = p.monthlyAllowance !== undefined;
    const effectiveAllowance = allowanceProvided
      ? (p.monthlyAllowance as number)
      : Number(cur?.monthlyAllowance ?? 0);
    const [row] = await tx
      .insert(compensation)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        basicSalary: money(p.basicSalary),
        currency: p.currency ?? 'MYR',
        monthlyAllowance: money(effectiveAllowance),
        remarks: p.remarks ?? null,
        validFrom: p.effectiveFrom,
        validTo: null,
      })
      .returning({ id: compensation.id });
    const fieldsChanged = ['basicSalary'];
    if (allowanceProvided) fieldsChanged.push('monthlyAllowance');
    if (p.remarks) fieldsChanged.push('remarks');
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'compensation',
      aggregateId: row.id,
      eventType: 'compensation.set',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // PDPA redact-to-reference (ADR-0030 Layer 0): the salary AND the remarks text live on
      // compensation[aggregateId]; the event keeps who/what/when + a reference, never cleartext pay or
      // remark text in the append-only log.
      payload: { employmentId: p.employmentId, effectiveFrom: p.effectiveFrom, fieldsChanged },
    });
    return { compensationId: row.id };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

/**
 * Edit Salary Record (feedback 87c82b18, flow #4; widened for 7c7c2f80). Corrects the basic salary,
 * remarks and/or EFFECTIVE DATE of an EXISTING salary-history row **in place** — used to fix the latest
 * (active) or a future-effective record before it takes effect. Business rule: only the OPEN row
 * (`validTo IS NULL`, not superseded) may be edited; historical (closed) rows are immutable, preserving
 * the audit chain.
 *
 * Effective-date move (7c7c2f80): moving `validFrom` must keep the temporal chain valid under the
 * compensation_no_overlap EXCLUDE constraint. The ADJACENT previous row (its validTo == this row's old
 * validFrom) is re-closed to the new date so the chain stays contiguous; any other collision, or a move
 * that would swallow the previous record entirely, is rejected with a clear message. A move whose span
 * crosses a CLOSED payroll period for this employment is refused — the closed run's payslips relied on
 * which record was in force in that window.
 *
 * Stamps `updatedAt` and appends a `compensation.updated` DomainEvent (the audit log the ticket asks
 * for). Substrate discipline: a write with its event, actor from ctx.
 */
export async function updateCompensation(
  ctx: SessionContext,
  p: {
    compensationId: string;
    employmentId: string;
    basicSalary?: number;
    remarks?: string | null;
    /** New effective date (7c7c2f80) — open row only; overlap + closed-period rules apply. */
    validFrom?: string;
  },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(compensation)
      .where(
        and(
          eq(compensation.id, p.compensationId),
          eq(compensation.employmentId, p.employmentId),
        ),
      )
      .limit(1);
    if (!row) throw new Error('Salary record not found');
    // Immutability guard: closed (historical) or superseded rows cannot be edited — only the open row
    // (latest active OR future-effective) is mutable. This is the audit guarantee the ticket relies on.
    if (row.validTo !== null || row.supersededAt !== null) {
      throw new Error('Only the latest or a future salary record can be edited');
    }
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const fieldsChanged: string[] = [];
    if (p.basicSalary !== undefined) {
      set.basicSalary = money(p.basicSalary);
      fieldsChanged.push('basicSalary');
    }
    if (p.remarks !== undefined) {
      set.remarks = p.remarks && p.remarks.trim() ? p.remarks.trim() : null;
      fieldsChanged.push('remarks');
    }
    // Effective-date move. `prevAdjacent` is deliberately resolved BEFORE the main update so the
    // truncate/extend of the neighbour and the row's own move are ordered to satisfy the EXCLUDE
    // constraint at every intermediate statement (ranges are checked per-statement, not deferred).
    let prevAdjacent: { id: string; validFrom: string } | null = null;
    const newFrom = p.validFrom;
    if (newFrom !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(newFrom)) {
      throw new Error('A valid effective date is required');
    }
    if (newFrom !== undefined && newFrom !== row.validFrom) {
      // A move whose span touches a closed payroll period would rewrite which record was in force
      // during an already-finalized run. Blocked (plan decision: closed periods stay protected).
      const span: [string, string] =
        newFrom < row.validFrom ? [newFrom, row.validFrom] : [row.validFrom, newFrom];
      const closed = await closedPeriodsTx(tx, p.employmentId);
      if (overlapsClosedPeriod(closed, span[0], span[1])) {
        throw new Error('The effective date cannot be moved across a closed payroll period');
      }
      const siblings = await tx
        .select({ id: compensation.id, validFrom: compensation.validFrom, validTo: compensation.validTo })
        .from(compensation)
        .where(
          and(
            eq(compensation.employmentId, p.employmentId),
            isNull(compensation.supersededAt),
            ne(compensation.id, row.id),
          ),
        );
      const adjacent = siblings.find((s) => s.validTo === row.validFrom) ?? null;
      for (const s of siblings) {
        if (adjacent && s.id === adjacent.id) continue; // the neighbour is re-closed below, not a collision
        if (s.validFrom < (row.validTo ?? '9999-12-31') && newFrom < (s.validTo ?? '9999-12-31')) {
          throw new Error('The new effective date overlaps another salary record');
        }
      }
      if (adjacent && newFrom <= adjacent.validFrom) {
        throw new Error(
          'The new effective date must be after the previous salary record starts — delete that record instead',
        );
      }
      prevAdjacent = adjacent;
      set.validFrom = newFrom;
      fieldsChanged.push('validFrom');
      // Moving EARLIER shrinks the neighbour first (no overlap at any point); moving LATER moves this
      // row first, then extends the neighbour into the vacated window.
      if (prevAdjacent && newFrom < row.validFrom) {
        await tx.update(compensation).set({ validTo: newFrom }).where(eq(compensation.id, prevAdjacent.id));
      }
    }
    if (fieldsChanged.length === 0) return { compensationId: row.id };
    await tx.update(compensation).set(set).where(eq(compensation.id, row.id));
    if (prevAdjacent && newFrom !== undefined && newFrom > row.validFrom) {
      await tx.update(compensation).set({ validTo: newFrom }).where(eq(compensation.id, prevAdjacent.id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'compensation',
      aggregateId: row.id,
      eventType: 'compensation.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // PDPA redact-to-reference (ADR-0030 Layer 0): no salary amount / remark text in the append-only
      // log; the corrected values live on compensation[aggregateId]. Only who/what-changed/when is logged.
      payload: { employmentId: p.employmentId, effectiveFrom: newFrom ?? row.validFrom, fieldsChanged },
    });
    return { compensationId: row.id };
  });
}

/**
 * Delete Salary Record (7c7c2f80) — a SOFT delete: sets `superseded_at` rather than issuing a DELETE.
 * Payslips snapshot the paid figure but carry NO FK back to compensation, so a true erase would leave a
 * closed payslip's amount unexplainable for audit; superseding hides the row from every read (history,
 * payroll resolution, the EXCLUDE constraint's scope) while the justification survives.
 *
 * Rules:
 *  - A record whose [validFrom, validTo) window overlaps a CLOSED payroll period for this employment
 *    cannot be removed (service check here + the 0277 DB trigger as backstop).
 *  - The ADJACENT previous record (validTo == this record's validFrom) is extended over the vacated
 *    window — deleting the newest record REOPENS the previous salary (validTo back to NULL), so the
 *    employee never loses their current salary for payroll generation.
 *  - RLS: the write is an UPDATE, so the compensation policy's WITH CHECK applies — admins (and
 *    perf-comp partners) only; a payroll partner or the employee themselves is refused by the DB.
 *
 * Appends a `compensation.superseded` DomainEvent (PDPA redact-to-reference: who/what/when + reference,
 * never the amount).
 */
export async function supersedeCompensation(
  ctx: SessionContext,
  p: { compensationId: string; employmentId: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(compensation)
      .where(
        and(
          eq(compensation.id, p.compensationId),
          eq(compensation.employmentId, p.employmentId),
        ),
      )
      .limit(1);
    if (!row) throw new Error('Salary record not found');
    if (row.supersededAt !== null) throw new Error('This salary record has already been deleted');
    const closed = await closedPeriodsTx(tx, p.employmentId);
    if (overlapsClosedPeriod(closed, row.validFrom, row.validTo)) {
      throw new Error('This salary record was used by a closed payroll run and cannot be deleted');
    }
    // Supersede FIRST: the EXCLUDE constraint is scoped WHERE superseded_at IS NULL, so the row leaves
    // the overlap scope before the neighbour is extended into its window.
    await tx.update(compensation).set({ supersededAt: new Date() }).where(eq(compensation.id, row.id));
    const [prevAdjacent] = await tx
      .select({ id: compensation.id })
      .from(compensation)
      .where(
        and(
          eq(compensation.employmentId, p.employmentId),
          isNull(compensation.supersededAt),
          eq(compensation.validTo, row.validFrom),
        ),
      )
      .limit(1);
    if (prevAdjacent) {
      await tx.update(compensation).set({ validTo: row.validTo }).where(eq(compensation.id, prevAdjacent.id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'compensation',
      aggregateId: row.id,
      eventType: 'compensation.superseded',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // PDPA redact-to-reference (ADR-0030 Layer 0): the removed amounts stay on the (hidden) row;
      // the append-only log records who removed which record and when, never the pay figures.
      payload: { employmentId: p.employmentId, effectiveFrom: row.validFrom, fieldsChanged: ['supersededAt'] },
    });
    return { compensationId: row.id };
  });
}

export function currentCompensation(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(compensation)
      .where(
        and(
          eq(compensation.employmentId, employmentId),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export function compensationHistory(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, (tx) =>
    tx
      .select()
      .from(compensation)
      .where(and(eq(compensation.employmentId, employmentId), isNull(compensation.supersededAt)))
      .orderBy(desc(compensation.validFrom)),
  );
}

export type CompensationHistoryRow = {
  id: string;
  basicSalary: string;
  currency: string;
  monthlyAllowance: string;
  remarks: string | null;
  validFrom: string;
  validTo: string | null;
  recordedAt: Date;
  /** Last in-place edit (Edit Salary Record flow); null until the row is edited. */
  updatedAt: Date | null;
  /** Full name of the user who created the record (from the compensation.set event); null for
   *  SYSTEM / import / agent writes. No longer shown on the Basic Salary screen (7c7c2f80 — audit
   *  detail lives in the Audit Trail), but still resolved for audit consumers. */
  createdByName: string | null;
};

/**
 * Basic Salary history for the screen (feedback 87c82b18): every non-superseded revision, newest first,
 * LEFT JOINed to its `compensation.set` DomainEvent → appUser → person to surface the creating actor
 * (mirrors `employeeAudit`'s actor join in core/read.ts). Read-only; RLS scopes compensation to
 * admin-or-self. Increment amount/%/status are derived at render time from `validFrom`/`validTo` (no
 * stored columns). The former second query resolving "Last Updated By" was removed with the on-screen
 * audit columns (7c7c2f80) — that detail belongs to the Audit Trail (compensation.updated events).
 */
export function compensationHistoryDetailed(
  ctx: SessionContext,
  employmentId: string,
): Promise<CompensationHistoryRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: compensation.id,
        basicSalary: compensation.basicSalary,
        currency: compensation.currency,
        monthlyAllowance: compensation.monthlyAllowance,
        remarks: compensation.remarks,
        validFrom: compensation.validFrom,
        validTo: compensation.validTo,
        recordedAt: compensation.recordedAt,
        updatedAt: compensation.updatedAt,
        createdByName: person.fullName,
      })
      .from(compensation)
      .leftJoin(
        domainEvent,
        and(eq(domainEvent.aggregateId, compensation.id), eq(domainEvent.eventType, 'compensation.set')),
      )
      .leftJoin(appUser, eq(appUser.id, domainEvent.actorId))
      .leftJoin(person, eq(person.id, appUser.personId))
      .where(and(eq(compensation.employmentId, employmentId), isNull(compensation.supersededAt)))
      .orderBy(desc(compensation.validFrom)),
  ) as Promise<CompensationHistoryRow[]>;
}

/** Next per-tenant employee code. Call INSIDE an existing transaction (e.g. during hire). */
export async function nextEmployeeCode(tx: Tx, tenantId: string): Promise<string> {
  const [row] = await tx
    .insert(tenantCounter)
    .values({ tenantId, kind: 'employee_code', value: 1 })
    .onConflictDoUpdate({
      target: [tenantCounter.tenantId, tenantCounter.kind],
      set: { value: sql`${tenantCounter.value} + 1` },
    })
    .returning({ value: tenantCounter.value });
  return `EMP-${String(row.value).padStart(4, '0')}`;
}
