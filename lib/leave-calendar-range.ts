/**
 * Leave Calendar week/month range resolution (item ee55f5fe).
 *
 * Pure, DB-free date arithmetic for the dashboard Leave Calendar's Week View / Month View switch:
 *  - the ?cal= param / `leave_calendar_view` session-cookie precedence,
 *  - the resolved [from, to] window for either view off a single ?abs=YYYY-MM-DD anchor,
 *  - whole-month stepping (lifted from app/attendance/page.tsx's proven shiftMonth arithmetic, so
 *    31 Jan + 1 month is 1 Feb and never drifts),
 *  - the view-switch re-anchor rule that keeps month → week → month landing where it started.
 *
 * All arithmetic is UTC. This module must stay import-free (no DB, no React) so it unit-tests
 * without Postgres and is safe to import from client components.
 */

export type CalendarView = 'week' | 'month';

const MS_DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (msVal: number) => new Date(msVal).toISOString().slice(0, 10);

/** 'month' only on the exact string 'month'; anything else (undefined, '', garbage) is 'week'. */
export function parseCalendarView(raw: string | undefined | null): CalendarView {
  return raw === 'month' ? 'month' : 'week';
}

/**
 * View preference precedence: explicit ?cal= param → session cookie → 'week'.
 * A shared /?cal=week link must win over the viewer's month cookie, so a PRESENT param always
 * decides (even when it parses to the default). Extracted as a pure function so the precedence
 * rule is unit-testable rather than inline page logic.
 */
export function resolveViewPreference({
  param,
  cookie,
}: {
  param?: string | null;
  cookie?: string | null;
}): CalendarView {
  if (param != null) return parseCalendarView(param);
  if (cookie != null) return parseCalendarView(cookie);
  return 'week';
}

/** Monday-align an ISO date backwards: getUTCDay() is 0=Sun..6=Sat, so Monday is (dow+6)%7 days back. */
export function mondayOfIso(iso: string): string {
  const t = ms(iso);
  const dow = new Date(t).getUTCDay();
  return isoOf(t - ((dow + 6) % 7) * MS_DAY);
}

/** First day of the month `by` whole months away. Date.UTC(y, m-1+by, 1) never drifts on short months. */
export function shiftMonthIso(iso: string, by: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return isoOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + by, 1));
}

/**
 * Resolve the calendar window for a view off the single ?abs anchor (defaulting to today):
 *  - week: Monday-aligned back from the anchor, 7 days (byte-identical to the pre-ee55f5fe window);
 *  - month: the 1st to the last day of the anchor's month, days ∈ {28, 29, 30, 31}.
 */
export function resolveCalendarRange({
  view,
  anchorIso,
  todayIso,
}: {
  view: CalendarView;
  anchorIso?: string | null;
  todayIso: string;
}): { from: string; to: string; days: number } {
  const anchor = anchorIso ?? todayIso;
  if (view === 'month') {
    const d = new Date(`${anchor}T00:00:00Z`);
    const fromMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    // Day 0 of the NEXT month = the last day of this month.
    const toMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
    return { from: isoOf(fromMs), to: isoOf(toMs), days: Math.round((toMs - fromMs) / MS_DAY) + 1 };
  }
  const from = mondayOfIso(anchor);
  return { from, to: isoOf(ms(from) + 6 * MS_DAY), days: 7 };
}

/**
 * The view-switch re-anchor rule (the month → week → month drift fix). The switch applies this to
 * the CURRENT window before pushing:
 *  - window contains today → null: DELETE ?abs entirely (falls back to today and re-enables the
 *    "Today" reset correctly);
 *  - otherwise → the window's midpoint date, so switching view never Monday-aligns the 1st of a
 *    month backwards into the previous month (or lands a month early on the way back).
 */
export function reanchorForView({
  from,
  to,
  todayIso,
}: {
  fromView: CalendarView;
  toView: CalendarView;
  from: string;
  to: string;
  todayIso: string;
}): string | null {
  if (from <= todayIso && todayIso <= to) return null;
  const days = Math.round((ms(to) - ms(from)) / MS_DAY) + 1;
  return isoOf(ms(from) + Math.floor((days - 1) / 2) * MS_DAY);
}
