/**
 * r301 (e5018593) — THE ONE MESSAGE A GENERATE ENTITLEMENT RUN ENDS WITH.
 *
 * The run now does two things — the year-open grant and, for earned Annual Leave, the accrual — and the
 * reporter was promised one message covering both. This composes it from the RESULT alone: every figure is
 * one the engines returned (core/leave-generation.ts), nothing is re-derived, and the wording picks between
 * sentences only on facts the result states outright.
 *
 * TWO CHANNELS, ON PURPOSE. `toast` is what happened; `error` is set only when the earned half FAILED. The
 * generation before it is committed and stays committed, so the run is not a failure and must not read as
 * one — but an earned part that did not run is not a success either, and a green toast would bury it. The
 * action posts `error` through the page's existing `?error=` channel beside the toast.
 *
 * ⚠️ WHAT `granted` COUNTS. It is EMPLOYEE × LEAVE TYPE records — `openLeaveYear` counts one per pair — and the
 * old toast said "{granted} employee(s)", which overstated the head count by the number of types selected.
 * The earned figures ARE employees: an accrual pair is one employee on the one active Annual Leave r299
 * allows. Those two nouns are the difference between the sentences below and the one they replace.
 *
 * Pure and framework-free (a translator is passed in), so the node suite can drive it through the real
 * catalogues in all six locales without a request context.
 */
import type { LeaveGenerationResult } from '../core/leave-generation';

export type GenerationTranslate = (key: string, values?: Record<string, string | number>) => string;

export function leaveGenerationMessages(
  t: GenerationTranslate,
  res: Pick<LeaveGenerationResult, 'year' | 'granted' | 'skipped' | 'forfeits' | 'accrual'>,
): { toast: string; error: string | null } {
  const year = res.year;
  const parts = [t('generateToast', { year, granted: res.granted, skipped: res.skipped, forfeits: res.forfeits })];
  let error: string | null = null;
  const acc = res.accrual;
  if (acc) {
    if (acc.annualLeaveLines > 0) {
      if (acc.skippedFutureYear) {
        parts.push(t('generateToastAccrualFuture', { year }));
      } else if (acc.error !== null) {
        error = t('generateToastAccrualFailed', { year, reason: acc.error });
      } else if (acc.posted + acc.upToDate > 0) {
        parts.push(t('generateToastAccrualAdded', { posted: acc.posted, days: acc.days, upToDate: acc.upToDate }));
      } else {
        parts.push(t('generateToastAccrualNothing', { date: acc.asOf ?? '' }));
      }
    }
    if (acc.heldBackNextYearStarted > 0) {
      parts.push(t('generateToastAccrualHeldBack', { count: acc.heldBackNextYearStarted, year, nextYear: year + 1 }));
    }
    if (acc.notAnnualLeaveLines > 0) {
      parts.push(t('generateToastAccrualNotAnnualLeave', { count: acc.notAnnualLeaveLines }));
    }
  }
  return { toast: parts.join(' '), error };
}
