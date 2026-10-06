/**
 * A DATE PLUS AN EMPLOYMENT PERIOD — the one piece of calendar arithmetic behind every "probation ends on"
 * figure (r392, item 685d2380 step 1).
 *
 * Client-safe and pure: no DB, no clock, no timezone. Plain Y/M/D string arithmetic, because a `Date` built
 * from a bare ISO day and read back in local time is how a date moves by one across a timezone boundary.
 *
 * WHO CALLS IT, and why it is ONE function:
 *   • core/org.ts `computeProvisionalEndOn` — the single-hire form's full-time default (hire + N months).
 *   • lib/employee-draft-schema.ts `draftProvisionalEndOn` — which BOTH the draft's read-only "Probation
 *     ends on" line AND `completeEmployeeDraft` call. The plan's requirement is that the date HR is shown
 *     on the draft is the date the activated employee carries; two copies of this arithmetic is how those
 *     two would one day disagree.
 *
 * THE UNITS ARE THE WRITER'S (`EMPLOYMENT_PERIOD_UNITS`, core/org.ts): month, week, day.
 *   • month — calendar months, the day CLAMPED to the target month's last day, so 30 Nov + 3 months is
 *     28 Feb (29 in a leap year), never an overflow into March. This is the rule `computeProvisionalEndOn`
 *     has always applied; it now lives here and that function calls it.
 *   • week  — 7 days each.
 *   • day   — 1 day each.
 * A BLANK UNIT READS AS MONTH, because that is what the period control DISPLAYS when no unit is stored
 * (components/employment-period-fields.tsx renders `unit ?? 'month'`). Deriving anything else would compute
 * a date from a unit the screen is not showing.
 *
 * Returns null — never a guess — for anything it cannot honestly compute: a start that is not ISO
 * yyyy-mm-dd, a blank value, a value that is not a whole number of zero or more (the writer's own rule), or
 * an unknown unit. NOTE `Number('')` is 0, so blank is tested BEFORE the number is parsed.
 */
const ISO_DAY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Days in a 1-based month. Day 0 of the next month is the last day of this one. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, '0');

export function addEmploymentPeriod(
  start: string | null | undefined,
  value: string | number | null | undefined,
  unit: string | null | undefined,
): string | null {
  const m = ISO_DAY.exec((start ?? '').trim());
  if (!m) return null;
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0) return null;
  const u = unit === null || unit === undefined || String(unit).trim() === '' ? 'month' : String(unit).trim().toLowerCase();

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  if (u === 'month') {
    const total = mo - 1 + n; // 0-based month index after adding the months
    const ty = y + Math.floor(total / 12);
    const tm = (total % 12) + 1;
    return `${ty}-${pad(tm)}-${pad(Math.min(d, daysInMonth(ty, tm)))}`;
  }
  if (u === 'week' || u === 'day') {
    const t = new Date(Date.UTC(y, mo - 1, d + (u === 'week' ? n * 7 : n)));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  return null;
}
