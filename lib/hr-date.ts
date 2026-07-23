/**
 * The product's business-day clock. This is a Malaysia product: the database session timezone is
 * Asia/Kuala_Lumpur (both the local dev cluster and the demo server), so SQL `current_date` names the
 * MYT calendar day. Every TypeScript rule that mirrors a SQL date comparison MUST compute "today" the
 * same way, or the two sides disagree for the eight hours between UTC and MYT midnight (00:00–08:00
 * MYT) — exactly the window the 0279 login-block matrix test caught failing.
 *
 * Canonical home of the helper previously defined in core/leave.ts (which now re-exports it): pure,
 * dependency-free, safe to import from leaf modules like core/employment-status.ts and from tests.
 */
export const HR_LOCAL_TZ = 'Asia/Kuala_Lumpur';

/** "Today" in the tenant's local (Asia/Kuala_Lumpur) calendar as ISO yyyy-mm-dd. */
export function todayInKualaLumpur(now: Date = new Date()): string {
  // en-CA yields yyyy-mm-dd; the timeZone shifts the wall-clock date to MYT before formatting.
  return new Intl.DateTimeFormat('en-CA', { timeZone: HR_LOCAL_TZ }).format(now);
}
