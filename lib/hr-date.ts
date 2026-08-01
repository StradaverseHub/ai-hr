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

/**
 * Wall-clock time in the tenant's local calendar as HH:mm, 24-hour.
 *
 * Exists so a stamped date and its stamped time are read off the SAME clock. `Date.toTimeString()`
 * returns the HOST's local time, which is right on this deployment only because the box happens to be
 * set to MYT — pair it with a UTC date and a punch at 00:30 MYT records yesterday's date beside
 * today's time. Both halves now name the timezone explicitly rather than depending on the host.
 */
export function timeInKualaLumpur(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: HR_LOCAL_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}
