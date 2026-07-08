/**
 * Compensation — generic, jurisdiction-neutral, effective-dated (ADR-0008 #5).
 * Salary is comp *history*: a change CLOSE + INSERTs a new version. Amounts are tenant data.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { appUser, compensation, domainEvent, person, tenantCounter } from '../db/schema';

const money = (n: number | string): string => (typeof n === 'number' ? n.toFixed(2) : String(n));

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
 * Edit Salary Record (feedback 87c82b18, flow #4). Corrects the basic salary and/or remarks of an
 * EXISTING salary-history row **in place** — used to fix the latest (active) or a future-effective record
 * before it takes effect. Business rule: only the OPEN row (`validTo IS NULL`, not superseded) may be
 * edited; historical (closed) rows are immutable, preserving the audit chain. Editing never changes the
 * effective date or re-runs the CLOSE+INSERT machinery, so the increment/status the screen derives simply
 * recomputes from the new amount. Stamps `updatedAt` and appends a `compensation.updated` DomainEvent
 * (the audit log the ticket asks for). Substrate discipline: a write with its event, actor from ctx.
 */
export async function updateCompensation(
  ctx: SessionContext,
  p: {
    compensationId: string;
    employmentId: string;
    basicSalary?: number;
    remarks?: string | null;
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
    if (fieldsChanged.length === 0) return { compensationId: row.id };
    await tx.update(compensation).set(set).where(eq(compensation.id, row.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'compensation',
      aggregateId: row.id,
      eventType: 'compensation.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      // PDPA redact-to-reference (ADR-0030 Layer 0): no salary amount / remark text in the append-only
      // log; the corrected values live on compensation[aggregateId]. Only who/what-changed/when is logged.
      payload: { employmentId: p.employmentId, effectiveFrom: row.validFrom, fieldsChanged },
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
   *  SYSTEM / import / agent writes (rendered as '—' in the UI). */
  createdByName: string | null;
  /** Full name of the user who last edited the record (from the latest compensation.updated event);
   *  null when the row was never edited or the editor was SYSTEM (rendered as '—' in the UI). */
  updatedByName: string | null;
};

/**
 * Basic Salary history for the screen (feedback 87c82b18): every non-superseded revision, newest first,
 * LEFT JOINed to its `compensation.set` DomainEvent → appUser → person to surface **Created By** (mirrors
 * `employeeAudit`'s actor join in core/read.ts). Read-only; RLS scopes compensation to admin-or-self.
 * Increment amount/%/status are derived at render time from `validFrom`/`validTo` (no stored columns).
 */
export function compensationHistoryDetailed(
  ctx: SessionContext,
  employmentId: string,
): Promise<CompensationHistoryRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = (await tx
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
      .orderBy(desc(compensation.validFrom))) as Omit<CompensationHistoryRow, 'updatedByName'>[];

    // Last Updated By (feedback 87c82b18, section 7): resolve the actor of the LATEST compensation.updated
    // event per row (mirrors the Created By join, but there can be multiple edits so we pick the newest in
    // JS). Kept as a second query — a self-join for "latest per aggregate" is noise for a handful of rows.
    const ids = rows.map((r) => r.id);
    const updaterByComp = new Map<string, string | null>();
    if (ids.length > 0) {
      const updEvents = await tx
        .select({
          aggregateId: domainEvent.aggregateId,
          updatedByName: person.fullName,
        })
        .from(domainEvent)
        .leftJoin(appUser, eq(appUser.id, domainEvent.actorId))
        .leftJoin(person, eq(person.id, appUser.personId))
        .where(
          and(
            eq(domainEvent.eventType, 'compensation.updated'),
            inArray(domainEvent.aggregateId, ids),
          ),
        )
        .orderBy(desc(domainEvent.sequence));
      // updEvents is newest-first; the first row seen per aggregate is the latest edit's actor.
      for (const e of updEvents) {
        if (!updaterByComp.has(e.aggregateId)) updaterByComp.set(e.aggregateId, e.updatedByName ?? null);
      }
    }
    return rows.map((r) => ({ ...r, updatedByName: updaterByComp.get(r.id) ?? null }));
  }) as Promise<CompensationHistoryRow[]>;
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
