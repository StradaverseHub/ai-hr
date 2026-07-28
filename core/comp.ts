/**
 * Compensation — generic, jurisdiction-neutral, effective-dated (ADR-0008 #5).
 * Salary is comp *history*: a change CLOSE + INSERTs a new version. Amounts are tenant data.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent, type MovementTag } from '../db/events';
import {
  appUser,
  compensation,
  domainEvent,
  payrollBatch,
  payrollPolicyTypeEnum,
  payslip,
  person,
  tenantCounter,
  type PayrollFrequency,
} from '../db/schema';
import { PAYROLL_FREQUENCIES } from './payroll-policy-config';
import { isCurrencyCode } from '../lib/currencies';

const money = (n: number | string): string => (typeof n === 'number' ? n.toFixed(2) : String(n));

/** 297ae65a — salary currency must be a real ISO 4217 code (lib/currencies.ts master). Throws on any
 *  other value so a crafted post can never store a junk currency on a salary record. */
function normalizeCurrency(v: string): string {
  const c = v.trim().toUpperCase();
  if (!isCurrencyCode(c)) throw new Error('Unknown currency');
  return c;
}

// ─────────────── Employee-specific salary structure (feedback 642ecc55 / ADR-0078) ───────────────
// pay_mode reuses the payroll_policy_type enum values; payment_term is validated against the
// PayrollFrequency TS union (mirroring core/payroll-policy-config.ts cleanFrequency — no second pg enum).
export const PAY_MODES = payrollPolicyTypeEnum.enumValues;
export type PayMode = (typeof PAY_MODES)[number];

/** ADR-0078 D4 — a Pay Mode change is only valid on a pay-period boundary (the 1st of a month). The engine
 *  reads ONE open compensation row for the whole period and the increment-proration path day-weight-blends
 *  two straddling rows — a blend across two different pay modes is meaningless, so mid-period conversions
 *  are rejected at the service. Salary AMOUNT changes keep today's mid-period behaviour untouched. */
export class PayModePeriodBoundaryError extends Error {
  constructor(message = 'A pay-mode change must take effect on the first day of a pay period') {
    super(message);
    this.name = 'PayModePeriodBoundaryError';
  }
}

const isPeriodBoundary = (d: string): boolean => /^\d{4}-\d{2}-01$/.test(d);

function normalizePayMode(v: string): PayMode {
  if (!PAY_MODES.includes(v as PayMode)) throw new Error('Unknown pay mode');
  return v as PayMode;
}

function normalizePaymentTerm(v: string): PayrollFrequency {
  if (!PAYROLL_FREQUENCIES.includes(v as PayrollFrequency)) throw new Error('Unknown payment term');
  return v as PayrollFrequency;
}

/** Daily/hourly pay is rate × days / rate × hours — a missing rate would silently pay 0. Fail at write. */
function assertRateForMode(payMode: PayMode, rateAmount: string | null): void {
  if ((payMode === 'daily' || payMode === 'hourly') && (rateAmount == null || !(Number(rateAmount) > 0))) {
    throw new Error('A daily or hourly pay mode requires a rate greater than zero');
  }
}

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

/** 'YYYY-MM' periods of CLOSED payroll batches that produced a payslip for this employment (tx-level).
 *  Exported for 66a63bd6: a Movement correction must refuse on exactly the periods the Basic Salary card
 *  already protects, so there is ONE definition of "payroll evidence" rather than two that can drift. */
export async function closedPeriodsTx(tx: Tx, employmentId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ period: payrollBatch.payPeriod })
    .from(payslip)
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .where(and(eq(payslip.employmentId, employmentId), eq(payrollBatch.status, 'closed')));
  return rows.map((r) => r.period);
}

/** 'YYYY-MM' periods of PROCESSED-or-CLOSED batches that paid this employment (ADR-0078 D4): an in-place
 *  pay-mode edit on a row whose window such a run already relied on would retroactively change how that
 *  period was computed on any reprocess (mode from record A, money from record B). */
export async function processedPeriodsTx(tx: Tx, employmentId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ period: payrollBatch.payPeriod })
    .from(payslip)
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .where(and(eq(payslip.employmentId, employmentId), inArray(payrollBatch.status, ['processed', 'closed'])));
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
    /** ISO 4217 code (297ae65a), validated against lib/currencies.ts. Omit to CARRY FORWARD the current
     *  record's currency (MYR for a brand-new first record) — a basic-only revision must never silently
     *  reset an SGD salary to MYR. */
    currency?: string;
    /** Omit to CARRY FORWARD the current record's allowance — a basic-salary-only revision must NOT wipe
     *  the monthly allowance (it feeds the OT ORP wage basis). Pass an explicit number (including 0) to set
     *  it; import / backfill paths pass explicit values. Allowances are now maintained via Pay Components. */
    monthlyAllowance?: number;
    /** Free-text reason for the change (Basic Salary screen, feedback 87c82b18). */
    remarks?: string;
    /** ADR-0078 — employee-specific salary structure. Omit any of the three to CARRY FORWARD the current
     *  record's value (same semantics as monthlyAllowance), so a basic-only revision never resets the
     *  structure. Defaults for a brand-new first record: monthly / monthly / no rate. A pay-mode CHANGE
     *  must take effect on a period boundary (D4); daily/hourly require a positive rateAmount. */
    payMode?: string;
    paymentTerm?: string;
    /** Per-day / per-hour rate (RM). Pass null to clear it (only valid for monthly/custom_period). */
    rateAmount?: number | null;
    effectiveFrom: string;
    /** 78853b97 — optional movement classification tag. Only the structural keys are merged into the
     *  event payload (`type`, `secondary`, `groupId`):
     *  the tag NEVER carries pay or remark text for comp events (ADR-0030 redact-to-reference — remarks
     *  live on the compensation row and are reconstructed at read time). */
    movement?: MovementTag;
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
    // ADR-0078 — pay structure with the SAME carry-forward semantics as monthlyAllowance: an omitted field
    // keeps the prior record's value (monthly/monthly/null for a brand-new first record), so a basic-only
    // revision never resets the structure. An explicit value sets it (rateAmount: null clears the rate).
    const payModeProvided = p.payMode !== undefined;
    const payMode: PayMode = payModeProvided
      ? normalizePayMode(p.payMode as string)
      : ((cur?.payMode as PayMode | undefined) ?? 'monthly');
    const paymentTermProvided = p.paymentTerm !== undefined;
    const paymentTerm: PayrollFrequency = paymentTermProvided
      ? normalizePaymentTerm(p.paymentTerm as string)
      : ((cur?.paymentTerm as PayrollFrequency | undefined) ?? 'monthly');
    const rateProvided = p.rateAmount !== undefined;
    const rateAmount: string | null = rateProvided
      ? p.rateAmount == null
        ? null
        : money(p.rateAmount)
      : (cur?.rateAmount ?? null);
    // 297ae65a — currency with the same carry-forward semantics: omitted keeps the prior record's currency
    // (MYR for a brand-new first record — the column default), so pre-currency callers (import, movement,
    // performance enact) stay byte-identical; a provided value is validated against the ISO 4217 master.
    const currencyProvided = p.currency !== undefined;
    const currency = currencyProvided ? normalizeCurrency(p.currency as string) : (cur?.currency ?? 'MYR');
    assertRateForMode(payMode, rateAmount);
    // D4 — a pay-mode CHANGE (relative to the record it supersedes) only takes effect on a period boundary.
    // The first record of an employment carries no prior mode, so it may start on any date (e.g. mid-month
    // hire of a daily worker).
    if (cur && (cur.payMode as PayMode) !== payMode && !isPeriodBoundary(p.effectiveFrom)) {
      throw new PayModePeriodBoundaryError();
    }
    const [row] = await tx
      .insert(compensation)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        basicSalary: money(p.basicSalary),
        currency,
        monthlyAllowance: money(effectiveAllowance),
        payMode,
        paymentTerm,
        rateAmount,
        remarks: p.remarks ?? null,
        validFrom: p.effectiveFrom,
        validTo: null,
      })
      .returning({ id: compensation.id });
    const fieldsChanged = ['basicSalary'];
    if (currencyProvided) fieldsChanged.push('currency');
    if (allowanceProvided) fieldsChanged.push('monthlyAllowance');
    if (payModeProvided) fieldsChanged.push('payMode');
    if (paymentTermProvided) fieldsChanged.push('paymentTerm');
    if (rateProvided) fieldsChanged.push('rateAmount');
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
      // remark text in the append-only log. The 78853b97 movement tag is stripped to its STRUCTURAL keys:
      // `type` plus (08913328) `secondary` and `groupId`, which carry no free text — a boolean and a
      // random correlation id. Dropping those two made a pay leg submitted as part of a Promotion render
      // as a SECOND, contradictory history row; `remarks` and `endDate` stay stripped.
      payload: {
        employmentId: p.employmentId,
        effectiveFrom: p.effectiveFrom,
        fieldsChanged,
        ...(p.movement
          ? {
              movement: {
                type: p.movement.type,
                ...(p.movement.secondary ? { secondary: true } : {}),
                ...(p.movement.groupId ? { groupId: p.movement.groupId } : {}),
              },
            }
          : {}),
      },
    });
    return { compensationId: row.id };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

/**
 * Edit Salary Record (feedback 87c82b18, flow #4; widened for 7c7c2f80; currency added by 297ae65a).
 * Corrects the basic salary, currency, remarks and/or EFFECTIVE DATE of an EXISTING salary-history row
 * **in place** — used to fix the latest
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
    /** ISO 4217 code (297ae65a) — edit the open row's salary currency in place; validated against
     *  lib/currencies.ts. Omitted or unchanged ⇒ no-op (nothing recorded). */
    currency?: string;
    remarks?: string | null;
    /** ADR-0078 — edit the open row's pay structure. A pay-mode change requires the row's effective date
     *  to be a period boundary AND rejects rows whose window a processed/closed run already relied on. */
    payMode?: string;
    paymentTerm?: string;
    /** Pass null to clear the rate (monthly/custom_period only — daily/hourly must keep a rate). */
    rateAmount?: number | null;
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
    // 297ae65a — currency edit: validated, recorded only on a real change (the edit form always posts it).
    if (p.currency !== undefined) {
      const nextCurrency = normalizeCurrency(p.currency);
      if (nextCurrency !== row.currency) {
        set.currency = nextCurrency;
        fieldsChanged.push('currency');
      }
    }
    if (p.remarks !== undefined) {
      set.remarks = p.remarks && p.remarks.trim() ? p.remarks.trim() : null;
      fieldsChanged.push('remarks');
    }
    // ADR-0078 — pay-structure edits on the open row. The rate consistency check runs against the row's
    // RESULTING mode+rate pair, so a mode flip to daily without a rate (or a rate clear on a daily row)
    // is rejected as one invalid combination.
    const nextPayMode: PayMode =
      p.payMode !== undefined ? normalizePayMode(p.payMode) : (row.payMode as PayMode);
    const nextRate: string | null =
      p.rateAmount !== undefined ? (p.rateAmount == null ? null : money(p.rateAmount)) : row.rateAmount;
    assertRateForMode(nextPayMode, nextRate);
    if (p.payMode !== undefined && nextPayMode !== (row.payMode as PayMode)) {
      // D4 — the (possibly moved) effective date must be a period boundary…
      const resultingFrom = p.validFrom !== undefined ? p.validFrom : row.validFrom;
      if (!isPeriodBoundary(resultingFrom)) throw new PayModePeriodBoundaryError();
      // …and a row whose window a PROCESSED/CLOSED run already relied on cannot change mode in place — a
      // reprocess would recompute that period under a different structure than the one that paid it.
      const processed = await processedPeriodsTx(tx, p.employmentId);
      if (overlapsClosedPeriod(processed, row.validFrom, row.validTo)) {
        throw new PayModePeriodBoundaryError(
          'This salary record was used by a processed payroll run — its pay mode can no longer be changed',
        );
      }
      set.payMode = nextPayMode;
      fieldsChanged.push('payMode');
    } else if (p.payMode !== undefined) {
      // Same mode re-submitted (the edit form always posts it) — not a change; nothing to record.
    }
    if (p.paymentTerm !== undefined) {
      const term = normalizePaymentTerm(p.paymentTerm);
      if (term !== (row.paymentTerm as PayrollFrequency)) {
        set.paymentTerm = term;
        fieldsChanged.push('paymentTerm');
      }
    }
    if (p.rateAmount !== undefined && nextRate !== row.rateAmount) {
      set.rateAmount = nextRate;
      fieldsChanged.push('rateAmount');
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
  /** 66a63bd6 — optional caller transaction (the run(outerTx) pattern setCompensation already uses), so a
   *  Movement rollback removes the pay leg atomically with the assignment / grade / reporting-line legs. */
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
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
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
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

export type EffectivePayStructure = {
  payMode: PayMode;
  paymentTerm: string;
  /** Per-day / per-hour rate; null for a monthly (or custom_period) employee. */
  rateAmount: string | null;
};

/**
 * ADR-0078 step 4 — the effective pay structure for an employment: pay mode, payment term and rate. Reads
 * the SAME open row the payroll engine joins (validTo IS NULL AND supersededAt IS NULL, core/payroll.ts) —
 * deliberately NOT a date-effective read, which on a reprocess would take the mode from a historical record
 * while the engine takes the money from the open one (mode from record A, money from record B). D4's
 * period-boundary constraint on pay-mode changes is what keeps the open-row read honest. Null when the
 * employment has no salary record yet.
 */
export function effectivePayStructure(
  ctx: SessionContext,
  employmentId: string,
): Promise<EffectivePayStructure | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        payMode: compensation.payMode,
        paymentTerm: compensation.paymentTerm,
        rateAmount: compensation.rateAmount,
      })
      .from(compensation)
      .where(
        and(
          eq(compensation.employmentId, employmentId),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .limit(1);
    return row ? { payMode: row.payMode as PayMode, paymentTerm: row.paymentTerm, rateAmount: row.rateAmount } : null;
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
  /** ADR-0078 — the salary structure in force for this record's window. */
  payMode: PayMode;
  paymentTerm: string;
  rateAmount: string | null;
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
        payMode: compensation.payMode,
        paymentTerm: compensation.paymentTerm,
        rateAmount: compensation.rateAmount,
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
