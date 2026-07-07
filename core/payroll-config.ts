/**
 * Per-company payroll scheduling config (ADR-0035 1B, #17). Cut-off day / pay day / payment basis are
 * scheduling METADATA (display + future automation), NOT inputs to the period computation. Upsert keyed
 * by company; RLS confines reads/writes to company-scoped admins. Every write appends a DomainEvent.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { companyPayrollConfig } from '../db/schema';

export const PAYMENT_BASES = ['monthly', 'daily', 'hourly', 'other'] as const;
export type PaymentBasis = (typeof PAYMENT_BASES)[number];

// Day-of-month 1–31, or null = month-end. Out-of-range/blank ⇒ null so a bad value never silently sticks.
const cleanDay = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : null;
};
const cleanBasis = (v: unknown): PaymentBasis => (PAYMENT_BASES.includes(v as PaymentBasis) ? (v as PaymentBasis) : 'monthly');

// Default probation length in months. Blank/invalid → null (= default 3, resolved at compute time). Reject
// <= 0 by falling back to null; NO arbitrary upper clamp (any positive integer is allowed per the plan).
const cleanProbation = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// 6522d26a — review reminder cadence: comma-separated days (or an array) → trunc, keep 1–365, dedupe,
// sort DESC. Blank / nothing valid → null (= default [30,14,7], resolved at sweep time). Capped at 10
// offsets so a typo can't schedule a reminder storm.
const cleanReminderDays = (v: unknown): number[] | null => {
  if (v === null || v === undefined || v === '') return null;
  const parts = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
  const clean = [
    ...new Set(parts.map((d) => Math.trunc(Number(d))).filter((d) => Number.isFinite(d) && d >= 1 && d <= 365)),
  ]
    .sort((a, b) => b - a)
    .slice(0, 10);
  return clean.length ? clean : null;
};

export type PayrollConfigInput = {
  companyId: string;
  cutOffDay?: number | string | null;
  payDay?: number | string | null;
  paymentBasis?: string;
  // Per-purpose cut-off scheduling metadata (1–31, null = month-end / inherit). Not inputs to period computation.
  overtimeCutOffDay?: number | string | null;
  claimCutOffDay?: number | string | null;
  unpaidLeaveCutOffDay?: number | string | null;
  attendanceCutOffDay?: number | string | null;
  // Configurable default probation length (months). Null = default 3.
  probationMonths?: number | string | null;
  // 6522d26a — review reminder cadence (days before the review end date). Null = default [30,14,7].
  reviewReminderDays?: number[] | string | null;
};

export async function setPayrollConfig(ctx: SessionContext, p: PayrollConfigInput) {
  const values = {
    cutOffDay: cleanDay(p.cutOffDay),
    payDay: cleanDay(p.payDay),
    paymentBasis: cleanBasis(p.paymentBasis),
    overtimeCutOffDay: cleanDay(p.overtimeCutOffDay),
    claimCutOffDay: cleanDay(p.claimCutOffDay),
    unpaidLeaveCutOffDay: cleanDay(p.unpaidLeaveCutOffDay),
    attendanceCutOffDay: cleanDay(p.attendanceCutOffDay),
    probationMonths: cleanProbation(p.probationMonths),
    reviewReminderDays: cleanReminderDays(p.reviewReminderDays),
  };
  return withTenant(ctx, async (tx) => {
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
