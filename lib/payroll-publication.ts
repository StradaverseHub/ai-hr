/**
 * Is a payroll run's pay VISIBLE TO EMPLOYEES yet? — ONE derivation, imported by both screens.
 *
 * Feedback ef31d251: eighteen runs were processed and not one was ever Closed, so no employee has ever
 * seen a payslip. The run detail screen rendered the raw `status` enum ("Processed"), which reads as
 * finished, and the payroll list had no indicator at all. Both screens now describe publication through
 * this function, for the same reason lib/leave-status.ts exists: two screens holding two copies of the
 * same rule is how they start disagreeing about what "published" means.
 *
 * WHY IT KEYS OFF `status`, NEVER OFF `closedAt`/`releasedAt` BEING NON-NULL.
 * `unlockClosedBatch` (core/payroll.ts) flips a run closed → processed through the `app.unlock_batch`
 * escape hatch and sets ONLY `{ status: 'processed' }` — it never clears `closed_at` or `released_at`.
 * A `closedAt != null` test would therefore report an unlocked run as still published while its payslips
 * have gone back to invisible in ESS. `status` is the field the ESS gate itself reads, so deriving from
 * it is what keeps this helper and the gate in lockstep.
 *
 * The four states mirror the ESS gate in core/read.ts `myPayslips`
 * (`released = status === 'closed' && (releasedAt == null || releasedAt <= now)`):
 *   draft       — nothing calculated yet; there are no payslips to hide.
 *   unpublished — calculated (processed) and deliberately hidden from employees until Close.
 *   scheduled   — closed, but the release instant is in the future, so still not visible.
 *   published   — closed and released; employees can see their payslips.
 *
 * `scheduled` is not hypothetical housekeeping: closeBatch derives releasedAt via `payslipReleaseAt`,
 * which returns a FUTURE date once the company has a `company_payroll_config` row with a 'fixed_day' or
 * 'relative' payslip-release mode. That table is empty today, so every close is immediate — the moment
 * the first config row lands, a screen that asserted "closing publishes immediately" would be lying.
 *
 * A NULL releasedAt on a closed run means published, not unscheduled: the ESS gate treats NULL as
 * released, and history-imported runs (core/payroll-history-import.ts) are inserted closed with both
 * closed_at and released_at NULL.
 */
export type PayrollPublicationState = 'draft' | 'unpublished' | 'scheduled' | 'published';

export function payrollPublicationState(
  batch: { status: string; releasedAt?: Date | null },
  now: Date = new Date(),
): PayrollPublicationState {
  if (batch.status === 'closed') {
    const releasedAt = batch.releasedAt ?? null;
    if (releasedAt == null) return 'published';
    return releasedAt.getTime() <= now.getTime() ? 'published' : 'scheduled';
  }
  if (batch.status === 'draft') return 'draft';
  // 'processed' — and any future non-terminal status: fail towards "not visible to employees", which is
  // the safe direction for a statement about who can see pay.
  return 'unpublished';
}

/**
 * Pill colour per publication state. `published` deliberately reuses the emerald of STATUS_STYLE.closed
 * in app/payroll/page.tsx so the existing closed pill does not change appearance; `unpublished` takes the
 * amber this repo already uses for "needs your attention, nothing is broken".
 */
export const PAYROLL_PUBLICATION_PILL: Record<PayrollPublicationState, string> = {
  draft: 'bg-muted text-muted-foreground',
  unpublished: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  scheduled: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  published: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
};
