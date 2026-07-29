/**
 * Per-company payroll scheduling config (ADR-0035 1B, #17). Cut-off day / pay day are the company-level
 * fallback of the cut-off resolution chain. Upsert keyed by company; RLS confines reads/writes to
 * company-scoped admins. Every write appends a DomainEvent.
 *
 * r79a (4fb8b75a steps 2–3) — this module is now payroll-ONLY. Four fields left it in migration 0324:
 *   • paymentBasis      DELETED. Nothing read it (see the migration header for the search that proved it).
 *   • probationMonths   MOVED to core/hiring-defaults.ts (company.probation_months) — a hiring setting.
 *   • reviewReminderDays MOVED to core/hiring-defaults.ts (company.review_reminder_days) — an
 *                        employment-review setting read only by the nightly reminder sweep.
 *   • defaultCurrency   MOVED to company.currency (core/admin.ts), which already existed and is owned by
 *                        Organization → General.
 * setPayrollConfig is a full-overwrite upsert, so removing a field from the input type is enough — no
 * caller can still write the dropped columns.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { companyPayrollConfig, payrollPolicy, type PayslipRelease } from '../db/schema';
import { cleanPayslipRelease } from './payroll-policy-config';

/** Thrown when the chosen company-default payroll policy is not a valid (same-company, active) policy. */
export class InvalidDefaultPolicyError extends Error {
  constructor(message = 'The chosen default payroll policy must be an active policy in this company') {
    super(message);
    this.name = 'InvalidDefaultPolicyError';
  }
}

// Day-of-month 1–31, or null = month-end. Out-of-range/blank ⇒ null so a bad value never silently sticks.
const cleanDay = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : null;
};

export type PayrollConfigInput = {
  companyId: string;
  cutOffDay?: number | string | null;
  payDay?: number | string | null;
  // Per-purpose cut-off scheduling metadata (1–31, null = month-end / inherit). Not inputs to period computation.
  overtimeCutOffDay?: number | string | null;
  claimCutOffDay?: number | string | null;
  unpaidLeaveCutOffDay?: number | string | null;
  attendanceCutOffDay?: number | string | null;
  // Step 1 (f3148da1) — the company-default payroll policy id, or null to clear. '' / undefined ⇒ clear.
  defaultPayrollPolicyId?: string | null;
  // Step 6 (f3148da1) — payslip release config (or null = immediate). Cleaned via cleanPayslipRelease.
  payslipRelease?: PayslipRelease | null;
};

export async function setPayrollConfig(ctx: SessionContext, p: PayrollConfigInput) {
  const rawDefaultPolicy = (p.defaultPayrollPolicyId ?? '').trim() || null;
  const payslipRelease = cleanPayslipRelease(p.payslipRelease);
  const values = {
    cutOffDay: cleanDay(p.cutOffDay),
    payDay: cleanDay(p.payDay),
    overtimeCutOffDay: cleanDay(p.overtimeCutOffDay),
    claimCutOffDay: cleanDay(p.claimCutOffDay),
    unpaidLeaveCutOffDay: cleanDay(p.unpaidLeaveCutOffDay),
    attendanceCutOffDay: cleanDay(p.attendanceCutOffDay),
    defaultPayrollPolicyId: rawDefaultPolicy,
    payslipRelease,
  };
  return withTenant(ctx, async (tx) => {
    // Step 1 — the chosen default policy MUST be an active policy in THIS company (RLS is tenant-wide, so a
    // same-tenant cross-company or inactive policy would otherwise slip through). Validate before the write.
    if (rawDefaultPolicy) {
      const [pol] = await tx
        .select({ companyId: payrollPolicy.companyId, status: payrollPolicy.status })
        .from(payrollPolicy)
        .where(eq(payrollPolicy.id, rawDefaultPolicy))
        .limit(1);
      if (!pol || pol.companyId !== p.companyId || pol.status !== 'active') throw new InvalidDefaultPolicyError();
    }
    const [existing] = await tx
      .select({ id: companyPayrollConfig.id })
      .from(companyPayrollConfig)
      .where(eq(companyPayrollConfig.companyId, p.companyId))
      .limit(1);
    let id: string;
    if (existing) {
      await tx
        .update(companyPayrollConfig)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(companyPayrollConfig.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx
        .insert(companyPayrollConfig)
        .values({ tenantId: ctx.tenantId, companyId: p.companyId, ...values })
        .returning({ id: companyPayrollConfig.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company-payroll-config',
      aggregateId: id,
      eventType: existing ? 'company.payroll-config.updated' : 'company.payroll-config.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, ...values },
    });
    return { id };
  });
}

export function getPayrollConfig(ctx: SessionContext, companyId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(companyPayrollConfig)
      .where(eq(companyPayrollConfig.companyId, companyId))
      .limit(1);
    return row ?? null;
  });
}

export function listPayrollConfigs(ctx: SessionContext, companyIds?: string[]) {
  return withTenant(ctx, (tx) =>
    companyIds && companyIds.length
      ? tx.select().from(companyPayrollConfig).where(inArray(companyPayrollConfig.companyId, companyIds))
      : tx.select().from(companyPayrollConfig),
  );
}
