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
// Cache only immutable formatters. Each call still formats its own fresh instant, including midnight.
const localDateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:HR_LOCAL_TZ});
const localTimeFormatter=new Intl.DateTimeFormat('en-GB',{timeZone:HR_LOCAL_TZ,hour:'2-digit',minute:'2-digit',hour12:false});

/** "Today" in the tenant's local (Asia/Kuala_Lumpur) calendar as ISO yyyy-mm-dd. */
export function todayInKualaLumpur(now: Date = new Date()): string {
  // en-CA yields yyyy-mm-dd; the timeZone shifts the wall-clock date to MYT before formatting.
  return localDateFormatter.format(now);
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
  return localTimeFormatter.format(now);
}

/**
 * The years a payroll-period picker should offer: `back` years of history ending at today's, plus
 * `selected` whenever it falls outside that window (6babf4f6).
 *
 * The second half is the part that earns the helper. A link can legitimately carry an older year — a
 * statutory amendment, a re-filing, a bookmark — and the page resolves it correctly. But a `<select>`
 * whose `defaultValue` matches no `<option>` falls back to its FIRST option, so the screen would show
 * the right figures under the wrong year label. Newest first, matching every other year picker here.
 */
export function yearOptions(today: string, selected?: string, back = 6): string[] {
  const thisYear = Number(today.slice(0, 4));
  const years = Array.from({ length: back + 1 }, (_, i) => String(thisYear - i));
  if (selected && /^\d{4}$/.test(selected) && !years.includes(selected)) {
    years.push(selected);
    years.sort((a, b) => b.localeCompare(a));
  }
  return years;
}

/**
 * cdb1c6ca — a payroll month ('YYYY-MM') as words in the reader's locale: "October 2026", "Oktober 2026".
 *
 * A pay period is a CALENDAR MONTH, not an instant, so it is formatted against a synthetic UTC date with
 * a UTC formatter — matched ends, so no host or tenant offset can move it into the neighbouring month.
 * Anything that is not a well-formed period is returned unchanged rather than formatted into a wrong one.
 */
export function formatPayPeriodMonth(payPeriod: string, locale: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(payPeriod);
  if (!m) return payPeriod;
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}
