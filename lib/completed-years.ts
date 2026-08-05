/**
 * Completed-whole-years calendar math — item 35b7af0a, group 3.
 *
 * CLIENT-SAFE ON PURPOSE, for exactly the reason `lib/person-vocabulary.ts` is: the SAME counter now has to
 * run on both sides of the wall. `core/leave.ts` (server-only — it imports the database) held these two
 * functions, and the Personnel Profile card could call them because it is a server component. The Create New
 * Employee wizard is a CLIENT component, so it could not — which is why the wizard had no Age field at all
 * even though the reporter listed "Age (auto-calculated)" as a Profile field. The alternative was a second
 * copy of the calendar math in the browser, and a second copy is the thing this whole item exists to remove.
 *
 * `core/leave.ts` imports from here and RE-EXPORTS both names, so every existing
 * `import { serviceYearsAt } from '@/core/leave'` (core/read.ts, core/analytics.ts, the leave engine itself
 * and four test files) keeps working untouched, against the same function identity.
 *
 * Nothing here touches a clock or a timezone: both inputs are already yyyy-mm-dd calendar dates and the math
 * is pure UTC date arithmetic. That is deliberate — the repo's rule is that date-only ARITHMETIC stays UTC
 * and only "what date is this instant" goes through `todayInKualaLumpur()`, which the CALLERS do.
 */

/** Completed years of service at a date (calendar-accurate, not /365.25). */
export const serviceYearsAt = (hiredOn: string, asOf: string): number => {
  const h = new Date(`${hiredOn}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  let y = a.getUTCFullYear() - h.getUTCFullYear();
  if (
    a.getUTCMonth() < h.getUTCMonth() ||
    (a.getUTCMonth() === h.getUTCMonth() && a.getUTCDate() < h.getUTCDate())
  ) {
    y -= 1;
  }
  return Math.max(0, y);
};

/**
 * Completed whole years between `from` and `asOf` — the anniversary-accurate counter behind the read-only
 * Age figure beside Date of Birth (feedback 9d13221c), rendered by BOTH the Personnel Profile card and the
 * Create New Employee wizard through `components/birth-date-fields.tsx`. Delegates to serviceYearsAt, so the
 * two can never disagree: the count increments ON the anniversary day itself and never before — a 29-Feb
 * birthday therefore increments on 1 Mar in common years (28-Feb is still before the anniversary). A
 * null/blank `from` returns null (the field shows "Not Available"); an `asOf` before `from` clamps to 0.
 * Pure + display-only: the age is never stored and never audited (DOB edits keep their existing audit trail)
 * — callers recompute against the current date on every view, so the figure is always that day's exact age
 * with zero maintenance. Future age consumers (analytics, retirement reports, directory columns) should
 * reuse THIS helper rather than reinventing the calendar math.
 */
export const completedYearsAt = (from: string | null | undefined, asOf: string): number | null =>
  from ? serviceYearsAt(from, asOf) : null;
