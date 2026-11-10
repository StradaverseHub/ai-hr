/**
 * Recruitment slice 6 rules — report periods, trend buckets, rates and durations. Pure, deterministic and client-safe:
 * no database, no clock (every "today" is passed in, from lib/hr-date's Kuala Lumpur calendar), no model.
 *
 * Every day here is a Kuala Lumpur calendar day written yyyy-mm-dd. Day arithmetic is calendar arithmetic on those
 * strings (UTC epoch days), so the host's time zone never moves an answer. Malaysia keeps no daylight saving time, so a
 * day's first instant is always `<day>T00:00:00+08:00`.
 */
import { isCalendarDate } from '../../lib/calendar-date';
import { addCalendarMonths } from '../../lib/hr-date';
import { isUuid } from './model';

export const REPORT_KINDS = ['overview', 'positions', 'interviews', 'team'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
/** The longest period a report may cover (owner scale bar, D-017). */
export const REPORT_MAX_MONTHS = 24;
/** The period a report opens on when none is chosen: the last three months, ending today. */
export const REPORT_DEFAULT_MONTHS = 3;
/** Periods up to this many weeks trend by Monday-start week; longer ones by calendar month. */
export const REPORT_WEEKLY_MAX_WEEKS = 13;
/** Per-job tables list at most this many jobs (those with the most applications in the period). */
export const REPORT_JOB_LIMIT = 100;
/** Team table rows (one per recruiter) are bounded the same way. */
export const REPORT_RECRUITER_LIMIT = 100;
/** The job filter offers at most this many jobs (newest first). */
export const REPORT_JOB_OPTION_LIMIT = 500;
/** Each statement's ceiling, set LOCAL inside the dashboard's read-only snapshot (a caller's tighter one is kept). */
export const REPORT_STATEMENT_TIMEOUT_MS = 5_000;
/**
 * The whole dashboard's time budget. PostgreSQL 16 has no transaction_timeout, so the service checks the elapsed time
 * before every statement: no statement STARTS after the budget, and each one is cut at REPORT_STATEMENT_TIMEOUT_MS, so a
 * snapshot lives at most budget + one statement ceiling (25 s).
 */
export const REPORT_BUDGET_MS = 20_000;
/** Report periods must lie within these years (inclusive). */
export const REPORT_MIN_YEAR = 2000;
export const REPORT_MAX_YEAR = 2100;
/** What a rate or ratio with a zero denominator shows. Never 0, never an error. */
export const NO_VALUE = '—';

export type ReportPeriod = { from: string; to: string };
export type Granularity = 'week' | 'month';
export type Bucket = { key: string; from: string; to: string };

const DAY_MS = 86_400_000;
const epochDay = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const fromEpochDay = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** A calendar day shifted by whole days. */
export function addDays(day: string, days: number): string {
  if (!isCalendarDate(day) || !Number.isSafeInteger(days)) throw new Error('Invalid calendar day offset.');
  return fromEpochDay(epochDay(day) + days);
}
/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new Error('Invalid calendar day.');
  return epochDay(to) - epochDay(from);
}

export type PeriodResult = { ok: true; period: ReportPeriod } | { ok: false; code: 'period_invalid' | 'period_too_long' };

/**
 * The period a report covers. Both ends are Kuala Lumpur days and inclusive. Omitted ends default to the last three
 * months ending `today` (from = the day after the same day three months earlier). A period longer than 24 months —
 * `to` on or after the day 24 calendar months after `from` — is refused, as is a reversed or malformed one.
 */
export function resolvePeriod(input: { from?: unknown; to?: unknown }, today: string): PeriodResult {
  const given = (v: unknown) => typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  // A day outside 2000–2100 (or any date the calendar helpers cannot shift) is refused as invalid, never thrown.
  const inRange = (day: string) => isCalendarDate(day) && Number(day.slice(0, 4)) >= REPORT_MIN_YEAR && Number(day.slice(0, 4)) <= REPORT_MAX_YEAR;
  try {
    const rawTo = given(input.to);
    const rawFrom = given(input.from);
    if ((rawTo && !inRange(rawTo)) || (rawFrom && !inRange(rawFrom))) return { ok: false, code: 'period_invalid' };
    const to = rawTo ?? today;
    const from = rawFrom ?? addDays(addCalendarMonths(to, -REPORT_DEFAULT_MONTHS), 1);
    if (!inRange(to) || !inRange(from) || daysBetween(from, to) < 0) return { ok: false, code: 'period_invalid' };
    if (to >= addCalendarMonths(from, REPORT_MAX_MONTHS)) return { ok: false, code: 'period_too_long' };
    // Everything the dashboards derive from the period must be computable too.
    periodInstants({ from, to });
    previousPeriod({ from, to });
    return { ok: true, period: { from, to } };
  } catch {
    return { ok: false, code: 'period_invalid' };
  }
}

/** The period's instants: from the first day's Kuala Lumpur midnight (inclusive) to the day after the last (exclusive). */
export function periodInstants(p: ReportPeriod): { fromTs: string; toTs: string } {
  return { fromTs: `${p.from}T00:00:00+08:00`, toTs: `${addDays(p.to, 1)}T00:00:00+08:00` };
}
/** The period of equal length immediately before `p` (for "change against the previous period"). */
export function previousPeriod(p: ReportPeriod): ReportPeriod {
  const length = daysBetween(p.from, p.to) + 1;
  return { from: addDays(p.from, -length), to: addDays(p.from, -1) };
}
/** Weekly trend for periods up to 13 weeks (91 days), monthly beyond. */
export function granularity(p: ReportPeriod): Granularity {
  return daysBetween(p.from, p.to) + 1 <= REPORT_WEEKLY_MAX_WEEKS * 7 ? 'week' : 'month';
}
/** The bucket a day falls in: the Monday on or before it, or the first of its month. */
export function bucketKey(day: string, g: Granularity): string {
  if (g === 'month') return `${day.slice(0, 7)}-01`;
  // 1970-01-01 was a Thursday: (epochDay + 3) mod 7 is 0 on Mondays.
  const n = epochDay(day);
  return fromEpochDay(n - (((n + 3) % 7) + 7) % 7);
}
/** Every bucket the period touches, in order, each clipped to the period. */
export function periodBuckets(p: ReportPeriod, g: Granularity = granularity(p)): Bucket[] {
  const out: Bucket[] = [];
  let key = bucketKey(p.from, g);
  while (key <= p.to) {
    const next = g === 'week' ? addDays(key, 7) : addCalendarMonths(key, 1);
    out.push({ key, from: key < p.from ? p.from : key, to: addDays(next, -1) > p.to ? p.to : addDays(next, -1) });
    key = next;
  }
  return out;
}
/** Counts keyed by bucket start (as SQL date_trunc returns them) laid onto every bucket, empty ones as 0. */
export function fillBuckets(p: ReportPeriod, counts: ReadonlyMap<string, number>, g: Granularity = granularity(p)): (Bucket & { count: number })[] {
  return periodBuckets(p, g).map((b) => ({ ...b, count: counts.get(b.key) ?? 0 }));
}

/** A rate or ratio: null (shown as "—") when the denominator is zero. */
export function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
/** The mean of whole-day durations given as their sum and count, rounded to a whole day; null when there are none. */
export function averageDays(sumDays: number, count: number): number | null {
  return count === 0 ? null : Math.round(sumDays / count);
}
/** Change against the previous period: the difference, and the relative change (null when the previous was zero). */
export function periodChange(current: number, previous: number): { delta: number; rate: number | null } {
  return { delta: current - previous, rate: rate(current - previous, previous) };
}
/** A share for a CSS bar: 0–100, rounded; 0 when the whole is zero. */
export function barPercent(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/** "—" for a missing rate; otherwise a percentage with at most one decimal, in the viewer's locale. */
export function formatPercent(value: number | null, locale: string): string {
  return value === null ? NO_VALUE : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}
/** "—" for a missing ratio or duration; otherwise a number with at most `digits` decimals. */
export function formatNumber(value: number | null, locale: string, digits = 1): string {
  return value === null ? NO_VALUE : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}
/** A signed change ("+3", "−2", "0") for the previous-period comparison. */
export function formatDelta(delta: number, locale: string): string {
  return new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' }).format(delta);
}

export type ReportFilterInput = { companyId?: unknown; jobId?: unknown; departmentId?: unknown; from?: unknown; to?: unknown };
export type ReportFilters = { companyId: string | null; jobId: string | null; departmentId: string | null; period: ReportPeriod };
/** Parse the GET filters: ids must be UUIDs (anything else is dropped), and the period is resolved and checked. */
export function parseReportFilters(input: ReportFilterInput, today: string): { ok: true; filters: ReportFilters } | { ok: false; code: 'period_invalid' | 'period_too_long' } {
  const period = resolvePeriod(input, today);
  if (!period.ok) return period;
  const id = (v: unknown) => (isUuid(v) ? v : null);
  return { ok: true, filters: { companyId: id(input.companyId), jobId: id(input.jobId), departmentId: id(input.departmentId), period: period.period } };
}
