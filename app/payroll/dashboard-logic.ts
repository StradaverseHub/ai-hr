/**
 * 7f6ca478 — the Payroll Process dashboard's filter arithmetic, kept pure so it can be unit-tested
 * without a DOM or a database AND imported from both the server page and its `'use client'` filter bar.
 * (Same arrangement as ./process/selection-logic.ts, and for the same reason.)
 *
 * The whole screen is driven by the address bar: ?year=2026&m=5&m=6&company=…&cycle=…&status=…
 * Nothing about the selection is stored per user — saved filter preferences are deliberately OUT of
 * scope for this piece of work (they are a new per-user write path, not layout), so a copied URL is
 * the only "saved view" and it works for everybody.
 */
import { todayInKualaLumpur } from '@/lib/hr-date';

/** Month numbers as the URL and the timeline speak them: 1 = January … 12 = December. */
export const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/**
 * The explicit "every month" value carried in the URL as `?m=all`.
 *
 * e440991b point 7 gives an ABSENT `?m` a meaning it did not have — "open on the current month" — and
 * that costs the address bar the ability to say "all twelve" by saying nothing. Unticking the last
 * month in the timeline would otherwise snap straight back to the current one, which is a worse trap
 * than the default it was added to fix. `dashboardHref` emits this token for an empty month set, so
 * the two states are distinguishable and every URL the UI builds round-trips exactly.
 */
export const ALL_MONTHS = 'all';

/**
 * The month (1-12) the TENANT is currently in.
 *
 * Through the tenant clock, never `new Date().getMonth()`. app/payroll/page.tsx already takes this
 * care with the year and says why: between 00:00 and 08:00 MYT the UTC date is still the previous
 * day, so on 1 January at 00:30 MYT `new Date()` says December of last year. On a screen organised by
 * year AND month that is two wrong defaults at once, for eight hours, on the one morning of the year
 * when someone is most likely to be opening a payroll run.
 */
export const currentTenantMonth = (now?: Date): number =>
  Number(todayInKualaLumpur(now).slice(5, 7));

/**
 * How far either side of "this year" the year <select> reaches. The arrows are NOT clamped to this
 * window — `yearOptions` always includes the selected year, so stepping past the edge extends the list
 * rather than dead-ending. A tenant whose oldest run is 2019 can still reach it; the window only decides
 * what the dropdown offers without being asked.
 */
const YEAR_BACK = 5;
const YEAR_FORWARD = 1;

/** 'YYYY-MM' for one (year, month1). */
export const periodOf = (year: number, month1: number): string =>
  `${year}-${String(month1).padStart(2, '0')}`;

/** The twelve periods of a year, ascending — the dashboard's ONE bounded read window. */
export const periodsForYear = (year: number): string[] => MONTHS.map((m) => periodOf(year, m));

/** The month number (1-12) of a 'YYYY-MM' period, or null if it is not one. */
export function monthOfPeriod(period: string): number | null {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.exec(period);
  return m ? Number(m[1]) : null;
}

/**
 * Resolve the ?year param. Anything that is not a plausible four-digit year falls back to the CALLER'S
 * "this year" — which the page must derive through the tenant timezone (todayInKualaLumpur), not
 * `new Date().getFullYear()`: between 00:00 and 08:00 MYT on 1 January those two disagree, and on a
 * year-month timeline that means opening on the wrong year for eight hours every New Year.
 */
export function parseYear(raw: string | string[] | undefined, thisYear: number): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(first);
  return Number.isInteger(n) && n >= 1900 && n <= 2999 ? n : thisYear;
}

/**
 * Resolve the repeated ?m params into a sorted, de-duplicated set of month numbers.
 *
 * An EMPTY result still means "the whole year", not "nothing" — that is what keeps the timeline
 * usable. Out-of-range and non-numeric values are dropped rather than clamped, so a hand-typed ?m=13
 * quietly means "no such month" instead of silently becoming December.
 *
 * e440991b POINT 7 — WHAT AN ABSENT `?m` MEANS CHANGED. It used to mean "the whole year", so opening
 * /payroll showed all twelve months at once; the reporter's complaint is that the screen does not open
 * on the month they are working in. It now means `[defaultMonth]`, and the default is the TENANT's
 * current month (see `currentTenantMonth` — a UTC-derived default opens January on December for the
 * first eight hours of the year).
 *
 * Three states, not two, and they are deliberately distinguishable:
 *   - param ABSENT      ⇒ [defaultMonth]  — "I just opened the screen"
 *   - `?m=all`          ⇒ []              — "I unticked everything; show me the year"
 *   - `?m=5&m=6`        ⇒ [5, 6]
 * Without the middle case, unticking the last month would silently re-select the current one and the
 * whole-year view would be unreachable from the UI. `dashboardHref` emits `?m=all` for an empty set,
 * so every link the screen builds round-trips through here unchanged.
 */
export function parseMonths(
  raw: string | string[] | undefined,
  defaultMonth: number = currentTenantMonth(),
): number[] {
  if (raw == null) return [defaultMonth];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Set<number>();
  for (const item of list) {
    for (const part of item.split(',')) {
      const trimmed = part.trim();
      if (trimmed === ALL_MONTHS) return []; // explicit whole-year, wins over anything else in the param
      const n = Number(trimmed);
      if (Number.isInteger(n) && n >= 1 && n <= 12) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Repeated-param values as a string[] (a single string becomes a 1-element array). */
export const asArray = (v: string | string[] | undefined): string[] =>
  v == null ? [] : Array.isArray(v) ? v : v ? [v] : [];

/**
 * The periods the GRID should show: the ticked months, or all twelve when none is ticked.
 *
 * Note this is NOT what is fetched. The read always asks for the whole year (periodsForYear) so the
 * timeline can put a run count on every month cell — a month you have not ticked still has to show you
 * whether there is anything in it, or the timeline is just twelve inert buttons.
 */
export const selectedPeriods = (year: number, months: readonly number[]): string[] =>
  (months.length ? [...months] : [...MONTHS]).map((m) => periodOf(year, m));

/** Years the dropdown offers: a window around `thisYear`, always including `selected`. */
export function yearOptions(selected: number, thisYear: number): number[] {
  const lo = Math.min(thisYear - YEAR_BACK, selected);
  const hi = Math.max(thisYear + YEAR_FORWARD, selected);
  return Array.from({ length: hi - lo + 1 }, (_, i) => hi - i);
}

/** One month cell of the timeline. */
export type MonthCell = { month: number; label: string; selected: boolean; runs: number };

/**
 * The twelve timeline cells for a year: label, selection state, and how many runs the year's fetched
 * rows put in that month. `labels` is 12 PRE-TRANSLATED short month names (the server formats them
 * with Intl against the request locale — month names are calendar data, not product copy, so they do
 * not belong in the message catalogs).
 */
export function monthCells(
  labels: readonly string[],
  months: readonly number[],
  rows: readonly { payPeriod: string }[],
): MonthCell[] {
  const counts = new Map<number, number>();
  for (const r of rows) {
    const m = monthOfPeriod(r.payPeriod);
    if (m != null) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const picked = new Set(months);
  return MONTHS.map((m) => ({
    month: m,
    label: labels[m - 1] ?? String(m),
    selected: picked.has(m),
    runs: counts.get(m) ?? 0,
  }));
}

/**
 * ── 0b326d5f (r256) — "REPROCESS REQUIRED", A DISPLAY STATE DERIVED FROM THE MARK ────────────────
 *
 * The reporter asked for a fourth payroll status. There is not one, and this build does not add one:
 * `payrollStatusEnum` is exactly ('draft','processed','closed') and db/schema.ts says so at the
 * `needsRecalcAt` column in as many words — "the mark is an ATTRIBUTE of a processed run, so nothing
 * that switches on status has to learn a new value". Every report, export, permission and service
 * predicate that already understands 'processed' therefore keeps working untouched, and a run that owes
 * a recalculation genuinely IS still processed; it is just stale.
 *
 * What was missing was the SIGNAL. The mechanism has been live since 49e7e0a2 — a one-off transaction
 * added, changed or removed on a processed run stamps `needs_recalc_at` with the exact employments, and
 * `closeBatch` refuses while it is set — but the Payroll Process listing still rendered those runs as a
 * plain "Processed", so nothing told the administrator the figures were out of date until Close was
 * refused. Measured on production 2026-09-08: SIX runs were carrying the mark and every one of them
 * read as Processed on this screen.
 *
 * ONE derivation, exported, for the same reason lib/payroll-publication.ts exists: the badge, the
 * affected-employee count and the STATUS FILTER all have to agree about which runs are stale, and three
 * inline `status === 'processed' && needsRecalcAt != null` tests are how they start disagreeing.
 */
export const REPROCESS_REQUIRED = 'reprocess_required';

/** The shape any of this reads — `listBatches` rows carry all three; tests may carry only `status`. */
export type RecalcMarkedRow = {
  status: string;
  needsRecalcAt?: Date | string | null;
  recalcEmploymentIds?: unknown;
};

/**
 * Does this run's own mark say its figures are stale?
 *
 * CLOSED IS NEVER STALE, whatever the flag says, and that is a rule rather than a defensive habit: the
 * reporter asked for exactly this ("it shall not override Closed status automatically"), a closed run is
 * immutable, and `unlockClosedBatch` flips closed → processed WITHOUT clearing `needs_recalc_at` — so a
 * run that was marked, then closed through an older path, would otherwise shout on a screen where there
 * is nothing the administrator can do about it. Keying on `status === 'processed'` (never on
 * `status !== 'draft'`) makes closed silent by construction.
 */
export function needsReprocess(b: RecalcMarkedRow): boolean {
  return b.status === 'processed' && b.needsRecalcAt != null;
}

/** What the listing SHOWS for a run: the stored status, or the derived state when the mark is set. */
export function payrollListState(b: RecalcMarkedRow): string {
  return needsReprocess(b) ? REPROCESS_REQUIRED : b.status;
}

/**
 * The employments this run is waiting on — the count the row prints, and exactly the set the selective
 * reprocess arrives pre-ticked with (app/payroll/[batchId]/reprocess reads the same column).
 *
 * Empty for a run that is not stale, so a leftover `recalc_employment_ids` on a cleared or closed run
 * can never put a count on screen. De-duplicated and type-filtered because the column is `jsonb`: what
 * comes back is whatever was written, not a checked `string[]`.
 */
export function reprocessEmploymentIds(b: RecalcMarkedRow): string[] {
  if (!needsReprocess(b)) return [];
  const ids = b.recalcEmploymentIds;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

/**
 * Apply the non-period filters in JS over the year's already-fetched rows.
 *
 * The PERIOD narrowing happens in SQL (listBatches takes the period set); company / cycle / status are
 * applied here because the read window is at most one year of runs and re-querying on every chip would
 * buy nothing. Every filter is a plain intersection — an empty selection means "no filter", never
 * "nothing", which keeps "All companies" as the default without a magic sentinel value.
 */
export function applyFilters<
  T extends {
    payPeriod: string;
    companyId: string;
    runType: string;
    status: string;
    needsRecalcAt?: Date | string | null;
  },
>(
  rows: readonly T[],
  f: { periods: readonly string[]; companyIds: readonly string[]; cycles: readonly string[]; statuses: readonly string[] },
): T[] {
  const periods = new Set(f.periods);
  const companies = new Set(f.companyIds);
  const cycles = new Set(f.cycles);
  const statuses = new Set(f.statuses);
  return rows.filter(
    (r) =>
      periods.has(r.payPeriod) &&
      (companies.size === 0 || companies.has(r.companyId)) &&
      (cycles.size === 0 || cycles.has(r.runType)) &&
      // 0b326d5f — the status filter reaches the DERIVED state as well as the stored one, and the two
      // are OR-ed rather than swapped. That is the decision, stated: "Processed" still means every
      // processed run INCLUDING the stale ones (the plan's promise that nothing which already
      // understands 'processed' changes meaning), and REPROCESS_REQUIRED narrows to just the stale
      // ones. Without this a chip would be on screen that the single-select filter could not reach.
      (statuses.size === 0 || statuses.has(r.status) || statuses.has(payrollListState(r))),
  );
}

/**
 * The summary tiles across the top: one count per REAL run state.
 *
 * The request asked for five tiles — Total, Draft, Processing, Completed and Failed. Three of those
 * states do not exist and cannot be counted, because they do not exist as data: `payroll_status` is
 * exactly ('draft','processed','closed'). Generation is synchronous and transactional, so there is no
 * moment at which a run is "processing" and nothing survives a run that fails. Counting a state that
 * cannot occur would put a permanent, authoritative "Failed: 0" on the screen — a reassurance the
 * system is in no position to give. So the tiles report what is real.
 */
export type StatusSummary = { total: number; draft: number; processed: number; closed: number };

export function summarise(rows: readonly { status: string }[]): StatusSummary {
  return {
    total: rows.length,
    draft: rows.filter((r) => r.status === 'draft').length,
    processed: rows.filter((r) => r.status === 'processed').length,
    closed: rows.filter((r) => r.status === 'closed').length,
  };
}

/** The dashboard's filter state, as it travels between the address bar, the page and the filter bar. */
export type DashboardFilters = {
  year: number;
  months: number[];
  companyIds: string[];
  cycles: string[];
  statuses: string[];
};

/**
 * Build the dashboard's address for a filter state. `page`/`size` are deliberately NOT carried: changing
 * a filter changes which rows exist, so staying on page 4 would land the reader past the end of the new
 * result and show them an empty table they did not ask for.
 */
export function dashboardHref(f: DashboardFilters, basePath = '/payroll'): string {
  const sp = new URLSearchParams();
  sp.set('year', String(f.year));
  // e440991b point 7 — an empty month set is written EXPLICITLY as ?m=all. Omitting it would produce a
  // URL that `parseMonths` reads as "just opened, default to this month", so unticking the last month
  // would bounce the reader back to the current one and the whole-year view would be unreachable.
  if (f.months.length === 0) sp.append('m', ALL_MONTHS);
  else for (const m of f.months) sp.append('m', String(m));
  for (const c of f.companyIds) sp.append('company', c);
  for (const c of f.cycles) sp.append('cycle', c);
  for (const s of f.statuses) sp.append('status', s);
  return `${basePath}?${sp.toString()}`;
}

/** Tick / untick ONE month, returning the next sorted month set. */
export function toggleMonth(months: readonly number[], month: number): number[] {
  const next = new Set(months);
  if (next.has(month)) next.delete(month);
  else next.add(month);
  return [...next].sort((a, b) => a - b);
}
