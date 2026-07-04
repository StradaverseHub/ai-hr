/**
 * Configurable Payroll Cycle master (ADR-0069). A COMPANY-scoped, admin-maintained catalog of the
 * friendly cycle names the Payroll Process wizard's "Payroll Cycle" dropdown offers, cloning the
 * leave_type / claim_type pattern (single archivedAt soft-delete, partial-unique on the live name).
 *
 * Each row maps to ONE of the four fixed behavioural run_types (payrollRunTypeEnum) — this makes the
 * LABEL/LIST configurable WITHOUT letting an admin invent new payroll math. The kernel still keys every
 * gating rule off run_type (core/payroll.ts). `remarks` carries an off_cycle preset's free-text label
 * (e.g. 'Advance Salary' / 'Mid-Month'), snapshotted onto the batch at creation exactly as today.
 *
 * Every state-changing method appends a DomainEvent inline in the same withTenant transaction (substrate
 * discipline). RLS confines reads to the tenant and writes to a payroll admin for the row's company.
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { payrollBatch, payrollCycle } from '../db/schema';

/** The four fixed behavioural run types a cycle may map to (mirrors payrollRunTypeEnum). */
export const PAYROLL_CYCLE_RUN_TYPES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;
export type PayrollCycleRunType = (typeof PAYROLL_CYCLE_RUN_TYPES)[number];

/** Thrown when a cycle name duplicates a live name in the same company (case-insensitive). */
export class PayrollCycleDuplicateNameError extends Error {
  constructor() {
    super('payroll-cycle-duplicate-name');
    this.name = 'PayrollCycleDuplicateNameError';
  }
}

/** Thrown when a create/update would leave a company with more than one ACTIVE cycle mapped to
 *  runType='regular'. Without this the SECOND regular-mapped cycle used in a run would fail with a raw,
 *  unlocalised Postgres constraint-violation (payroll_batch_one_regular_uq) — this makes it friendly. */
export class PayrollCycleRegularConflictError extends Error {
  constructor() {
    super('payroll-cycle-regular-conflict');
    this.name = 'PayrollCycleRegularConflictError';
  }
}

/** Thrown when a hard-delete is refused because the cycle is referenced by existing payroll batches
 *  (historical OR future) — deleting would orphan that run-type/remarks provenance. Archive instead. */
export class PayrollCycleInUseError extends Error {
  constructor(public readonly refs: number) {
    super('payroll-cycle-in-use');
    this.name = 'PayrollCycleInUseError';
  }
}

const cleanName = (v: string | undefined): string => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('Payroll cycle name is required');
  return s;
};

const cleanRunType = (v: string | undefined): PayrollCycleRunType => {
  if (!v || !(PAYROLL_CYCLE_RUN_TYPES as readonly string[]).includes(v)) {
    throw new Error(`Unknown payroll run type “${v}”.`);
  }
  return v as PayrollCycleRunType;
};

const cleanRemarks = (v: string | null | undefined): string | null => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};

const isUniqueViolation = (e: unknown): boolean => {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
};

/**
 * The default catalog seeded per company on adoption — the exact set the wizard offered before this
 * feature: the four straight-through behavioural cycles plus the two off_cycle presets. Seeding these
 * preserves the dropdown on upgrade (no one loses an option). `remarks` matches the label the legacy
 * actions.ts ternary carried for the two presets so the delete-guard traces existing history correctly.
 */
export const DEFAULT_PAYROLL_CYCLES: { name: string; runType: PayrollCycleRunType; remarks: string | null }[] = [
  { name: 'Monthly', runType: 'regular', remarks: null },
  { name: 'Bonus', runType: 'bonus', remarks: null },
  { name: 'Off-cycle', runType: 'off_cycle', remarks: null },
  { name: 'Adjustment', runType: 'adjustment', remarks: null },
  { name: 'Advance Salary', runType: 'off_cycle', remarks: 'Advance Salary' },
  { name: 'Mid-Month', runType: 'off_cycle', remarks: 'Mid-Month' },
];

/**
 * Idempotently seed the default cycle catalog for one company (by name). Safe to re-run: an existing live
 * name is left untouched. Appends a single catalog-level event. Admin-only via RLS.
 */
export function seedPayrollCycleCatalog(ctx: SessionContext, companyId: string) {
  return withTenant(ctx, async (tx) => {
    const existing = await tx
      .select({ name: payrollCycle.name })
      .from(payrollCycle)
      .where(eq(payrollCycle.companyId, companyId));
    const have = new Set(existing.map((r) => r.name.toLowerCase()));
    let created = 0;
    for (let i = 0; i < DEFAULT_PAYROLL_CYCLES.length; i++) {
      const c = DEFAULT_PAYROLL_CYCLES[i];
      if (have.has(c.name.toLowerCase())) continue;
      await tx.insert(payrollCycle).values({
        tenantId: ctx.tenantId,
        companyId,
        name: c.name,
        runType: c.runType,
        remarks: c.remarks,
        sortOrder: i,
      });
      created += 1;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-cycle',
      aggregateId: companyId, // catalog-level op keyed to the company
      eventType: 'payroll-cycle.catalog.seeded',
      actor: actorOf(ctx),
      payload: { total: DEFAULT_PAYROLL_CYCLES.length, created },
    });
    return { total: DEFAULT_PAYROLL_CYCLES.length, created };
  });
}

export type PayrollCycleRow = {
  id: string;
  companyId: string;
  name: string;
  runType: PayrollCycleRunType;
  remarks: string | null;
  sortOrder: number;
  archivedAt: Date | null;
};

/** List cycles for one or more companies, ordered by sortOrder then name. `activeOnly` hides archived. */
export function listPayrollCycles(
  ctx: SessionContext,
  companyId: string,
  opts: { activeOnly?: boolean } = {},
) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(payrollCycle)
      .where(eq(payrollCycle.companyId, companyId))
      .orderBy(asc(payrollCycle.sortOrder), asc(payrollCycle.name));
    const filtered = opts.activeOnly ? rows.filter((r) => r.archivedAt == null) : rows;
    return filtered.map(
      (r): PayrollCycleRow => ({
        id: r.id,
        companyId: r.companyId,
        name: r.name,
        runType: r.runType as PayrollCycleRunType,
        remarks: r.remarks,
        sortOrder: r.sortOrder,
        archivedAt: r.archivedAt,
      }),
    );
  });
}

/**
 * Resolve a single ACTIVE cycle by id, re-validating it belongs to the expected company (defence in depth
 * for the wizard submit path — the client sends only the id; the server derives runType/remarks from the
 * row, never trusting client-submitted values). Returns null if missing, archived, or company-mismatched.
 */
export function getActivePayrollCycle(ctx: SessionContext, id: string, companyId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(payrollCycle).where(eq(payrollCycle.id, id));
    if (!row || row.archivedAt != null || row.companyId !== companyId) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      runType: row.runType as PayrollCycleRunType,
      remarks: row.remarks,
    };
  });
}

/** Count ACTIVE regular-mapped cycles for a company, excluding an optional row (the one being updated).
 *  Enforces "at most one active regular-mapped cycle" at the app level (plan item 2). */
async function activeRegularCount(tx: Tx, companyId: string, excludeId?: string): Promise<number> {
  const conds = [
    eq(payrollCycle.companyId, companyId),
    eq(payrollCycle.runType, 'regular'),
    sql`${payrollCycle.archivedAt} IS NULL`,
  ];
  if (excludeId) conds.push(ne(payrollCycle.id, excludeId));
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(payrollCycle)
    .where(and(...conds));
  return row?.n ?? 0;
}

export type UpsertPayrollCycleInput = {
  id?: string;
  companyId: string;
  name: string;
  runType: string;
  remarks?: string | null;
  sortOrder?: number;
};

/**
 * Create or update a cycle. Case-insensitive duplicate-name is caught by the DB partial-unique index
 * (mapped to PayrollCycleDuplicateNameError). The "only one active regular-mapped cycle" invariant is
 * checked app-side BEFORE the write (a create/update that would make a second active regular cycle throws
 * PayrollCycleRegularConflictError). An update never activates a row — reactivation is a separate action.
 */
export async function upsertPayrollCycle(ctx: SessionContext, p: UpsertPayrollCycleInput) {
  const name = cleanName(p.name);
  const runType = cleanRunType(p.runType);
  const remarks = cleanRemarks(p.remarks);
  const sortOrder = Number.isFinite(p.sortOrder) ? Number(p.sortOrder) : 0;
  return withTenant(ctx, async (tx) => {
    if (p.id) {
      const [before] = await tx.select().from(payrollCycle).where(eq(payrollCycle.id, p.id));
      // Only guard when the row is (or becomes) an ACTIVE regular — an archived row can never conflict.
      if (runType === 'regular' && (before ? before.archivedAt == null : true)) {
        if ((await activeRegularCount(tx, p.companyId, p.id)) > 0) throw new PayrollCycleRegularConflictError();
      }
      await tx
        .update(payrollCycle)
        .set({ name, runType, remarks, sortOrder })
        .where(eq(payrollCycle.id, p.id))
        .catch((e) => {
          if (isUniqueViolation(e)) throw new PayrollCycleDuplicateNameError();
          throw e;
        });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-cycle',
        aggregateId: p.id,
        eventType: 'payroll-cycle.updated',
        actor: actorOf(ctx),
        payload: { before: before ? { name: before.name, runType: before.runType, remarks: before.remarks, sortOrder: before.sortOrder } : null, after: { name, runType, remarks, sortOrder } },
      });
      return { id: p.id };
    }
    // Create: a new active regular-mapped cycle must be the ONLY one.
    if (runType === 'regular' && (await activeRegularCount(tx, p.companyId)) > 0) {
      throw new PayrollCycleRegularConflictError();
    }
    const [row] = await tx
      .insert(payrollCycle)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, name, runType, remarks, sortOrder })
      .returning({ id: payrollCycle.id })
      .catch((e) => {
        if (isUniqueViolation(e)) throw new PayrollCycleDuplicateNameError();
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-cycle',
      aggregateId: row.id,
      eventType: 'payroll-cycle.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, name, runType, remarks, sortOrder },
    });
    return { id: row.id };
  });
}

/** Activate / deactivate (archive) a cycle via the archivedAt toggle. Activating a regular-mapped cycle
 *  re-runs the "only one active regular" guard (so it can't smuggle a second regular back in). */
export async function setPayrollCycleActive(ctx: SessionContext, p: { id: string; active: boolean }) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select().from(payrollCycle).where(eq(payrollCycle.id, p.id));
    if (!before) throw new Error('Payroll cycle not found');
    if (p.active && before.runType === 'regular') {
      if ((await activeRegularCount(tx, before.companyId, p.id)) > 0) throw new PayrollCycleRegularConflictError();
    }
    await tx
      .update(payrollCycle)
      .set({ archivedAt: p.active ? null : sql`now()` })
      .where(eq(payrollCycle.id, p.id))
      .catch((e) => {
        if (isUniqueViolation(e)) throw new PayrollCycleDuplicateNameError();
        throw e;
      });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-cycle',
      aggregateId: p.id,
      eventType: p.active ? 'payroll-cycle.activated' : 'payroll-cycle.deactivated',
      actor: actorOf(ctx),
      payload: {},
    });
    return { id: p.id };
  });
}

/**
 * Hard-delete a cycle. GUARDED against existing payroll_batch rows — covering HISTORICAL data (batches
 * created before this feature shipped) as well as future ones, per the ticket. Since there is no FK on
 * payroll_batch (the leaveType precedent counts by the type's own attributes), we count batches matching
 * this cycle's mapped runType, further narrowed by remarks text when the cycle carries a preset label
 * (Advance Salary / Mid-Month) so deleting one off_cycle preset does not falsely count another's runs.
 */
export async function deletePayrollCycle(ctx: SessionContext, id: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(payrollCycle).where(eq(payrollCycle.id, id));
    if (!row) throw new Error('Payroll cycle not found');
    const conds = [eq(payrollBatch.companyId, row.companyId), eq(payrollBatch.runType, row.runType)];
    // A preset off_cycle cycle only "owns" the batches carrying its exact remarks label — so two distinct
    // off_cycle presets don't block each other, and a plain off_cycle cycle (null remarks) is blocked by
    // any off_cycle batch that has no preset label.
    if (row.remarks != null) conds.push(eq(payrollBatch.remarks, row.remarks));
    const [cnt] = await tx.select({ n: sql<number>`count(*)::int` }).from(payrollBatch).where(and(...conds));
    const refs = cnt?.n ?? 0;
    if (refs > 0) throw new PayrollCycleInUseError(refs);
    await tx.delete(payrollCycle).where(eq(payrollCycle.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-cycle',
      aggregateId: id,
      eventType: 'payroll-cycle.deleted',
      actor: actorOf(ctx),
      payload: {},
    });
    return { id };
  });
}
