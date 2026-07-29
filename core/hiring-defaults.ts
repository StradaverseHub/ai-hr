/**
 * Per-company HIRING + EMPLOYMENT-REVIEW defaults (r79a, feedback 4fb8b75a step 3).
 *
 * Two settings that used to live on company_payroll_config — a payroll table neither of them has anything
 * to do with. Migration 0324 relocated them onto `company` (the 0287 leave-escalation precedent: `company`
 * already carries per-company module behaviour and already has RLS + the app grant, so a column beats a new
 * table). This module is their service seam, mirroring core/payroll-config.ts:
 *
 *   probationMonths     — default probation length for a FULL-TIME hire. The hire path turns it into
 *                         employment.provisional_end_on via core/org.ts computeProvisionalEndOn. NULL = the
 *                         code default of 3 (resolveProbationMonths), so an unconfigured company behaves
 *                         exactly as it does today.
 *   reviewReminderDays  — days BEFORE an employment review's end date at which the nightly sweep
 *                         (core/employment-review.ts sweepReviewReminders) nudges manager + HR. NULL/empty
 *                         = the code default [30, 14, 7] (resolveReminderDays).
 *
 * The cleaners are the SAME clamp-not-throw normalizers the payroll-config form used, moved verbatim, so a
 * value that round-tripped before round-trips identically now. They are also the JS mirror of the two named
 * CHECK constraints migration 0324 puts on the columns — a write that would violate the constraint is
 * clamped to NULL here rather than reaching the database.
 *
 * RLS: `company` is tenant-scoped for read; the UPDATE path is admin-gated by the caller (requireAdmin on
 * the screen) exactly as setCompanyDefaultPayrollCycle and setLeaveEscalationPolicy are. Every write
 * appends a DomainEvent with a before → after payload (the setLeaveHalfDayFullDeduction audit precedent).
 */
import { eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { company } from '../db/schema';

export type HiringDefaults = {
  companyId: string;
  probationMonths: number | null;
  reviewReminderDays: number[] | null;
};

/** Default probation length in months. Blank/invalid → null (= default 3, resolved at compute time). Reject
 *  <= 0 by falling back to null; NO arbitrary upper clamp (any positive integer is allowed). */
export const cleanProbationMonths = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Review reminder cadence: comma-separated days (or an array) → trunc, keep 1–365, dedupe, sort DESC.
 *  Blank / nothing valid → null (= default [30,14,7], resolved at sweep time). Capped at 10 offsets so a
 *  typo can't schedule a reminder storm. */
export const cleanReviewReminderDays = (v: unknown): number[] | null => {
  if (v === null || v === undefined || v === '') return null;
  const parts = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
  const clean = [
    ...new Set(parts.map((d) => Math.trunc(Number(d))).filter((d) => Number.isFinite(d) && d >= 1 && d <= 365)),
  ]
    .sort((a, b) => b - a)
    .slice(0, 10);
  return clean.length ? clean : null;
};

/** One company's hiring defaults, or null when the company is out of scope / does not exist. */
export function getHiringDefaults(ctx: SessionContext, companyId: string): Promise<HiringDefaults | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        companyId: company.id,
        probationMonths: company.probationMonths,
        reviewReminderDays: company.reviewReminderDays,
      })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    return row ?? null;
  });
}

/** The same, for a set of companies (the settings screen renders one row per company in scope). */
export function listHiringDefaults(ctx: SessionContext, companyIds?: string[]): Promise<HiringDefaults[]> {
  return withTenant(ctx, (tx) => {
    const q = tx
      .select({
        companyId: company.id,
        probationMonths: company.probationMonths,
        reviewReminderDays: company.reviewReminderDays,
      })
      .from(company);
    return companyIds && companyIds.length ? q.where(inArray(company.id, companyIds)) : q;
  });
}

/**
 * Save one company's hiring defaults. Both fields are cleaned to NULL when blank/invalid, which restores
 * the built-in default rather than storing a broken value — the clamp-not-throw module pattern.
 */
export async function setHiringDefaults(
  ctx: SessionContext,
  p: { companyId: string; probationMonths?: number | string | null; reviewReminderDays?: number[] | string | null },
) {
  const probationMonths = cleanProbationMonths(p.probationMonths);
  const reviewReminderDays = cleanReviewReminderDays(p.reviewReminderDays);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ probationMonths: company.probationMonths, reviewReminderDays: company.reviewReminderDays })
      .from(company)
      .where(eq(company.id, p.companyId))
      .limit(1);
    if (!before) throw new Error('Company not found');
    await tx
      .update(company)
      .set({ probationMonths, reviewReminderDays })
      .where(eq(company.id, p.companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: 'company.hiring-defaults.set',
      actor: actorOf(ctx),
      payload: {
        before: { probationMonths: before.probationMonths, reviewReminderDays: before.reviewReminderDays },
        after: { probationMonths, reviewReminderDays },
      },
    });
    return { id: p.companyId };
  });
}
