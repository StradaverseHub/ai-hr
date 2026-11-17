/**
 * Recruitment slice 17 rules — applications left unprocessed (docs/recruitment-reconstruction/specification.md "Slice 17", D-057).
 * Pure, deterministic and client-safe: no database, no clock, no model.
 *
 * A company's administrators set, per stage, a reminder after N days (1–365) and optionally "suggest archiving" after M days
 * (N < M ≤ 730), counted in calendar days or working days. Waiting is measured from the Kuala Lumpur calendar day the active
 * application entered its current stage to today (Kuala Lumpur): calendar days are the plain difference; working days count the
 * days AFTER the entry day up to and including today that are not a Saturday, a Sunday or one of the company's public holidays
 * (the holiday set comes from the existing holiday calendar, core/holidays.ts). An application is reminded once it has waited at
 * least N days, and suggested for archiving once it has waited at least M days. Nothing here archives anything: a person does.
 *
 * Set-based reads compare the entry day with a CUTOFF day per rule instead of counting days per application: an application has
 * waited at least N days exactly when it entered on or before `waitingCutoff(today, N, kind, holidays)` (proved by the unit tests
 * against `waitingDays`).
 */

export const WAITING_DAY_KINDS = ['calendar', 'working'] as const;
export type WaitingDayKind = (typeof WAITING_DAY_KINDS)[number];
export const WAITING_REMIND_MAX = 365;
export const WAITING_ARCHIVE_MAX = 730;
/** The board's filter values: past the reminder, or past the suggest-archiving threshold. */
export const WAITING_FILTERS = ['waiting', 'suggested'] as const;
export type WaitingFilter = (typeof WAITING_FILTERS)[number];
/** The waiting counts read at most this many active applications per stage (the board) or per job (the Overview) before looking up
 *  when each entered its stage, least recently updated first. updated_at is only a sort key that front-loads likely matches (a move
 *  sets it); every count comes from the history. A count over more than that reads "N+" (a lower bound). */
export const WAITING_SCAN_LIMIT = 500;
/** …and at most this many in all per board load (every stage with a limit across the companies in view); over it every stage's count
 *  reads "N+". Also bounds the ids the waiting filter carries. */
export const WAITING_BOARD_SCAN_LIMIT = 2000;
/** At most this many applications are listed (and archived in one action) on a job's "Suggested to archive" list. */
export const SUGGESTED_LIST_LIMIT = 200;
/** How far back public holidays are read for working-day counts: enough for 730 working days with any realistic calendar. Older
 *  entry days count weekends only (every such application is already past every threshold). */
export const HOLIDAY_LOOKBACK_DAYS = 1500;

export type WaitingRule = { stageId: string; remindDays: number; archiveDays: number | null; dayKind: WaitingDayKind };
export type WaitingLevel = 'none' | 'waiting' | 'suggested';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (date: string): number => {
  if (!DATE.test(date)) throw new Error('Expected a yyyy-mm-dd day.');
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error('Expected a real calendar day.');
  return Math.round(ms / 86_400_000);
};
const fromDayNumber = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** `date` shifted by `days` calendar days (no host time zone involved). */
export function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}
/** Saturday or Sunday. */
export function isWeekend(date: string): boolean {
  const weekday = (dayNumber(date) + 4) % 7; // 1970-01-01 was a Thursday (4); 0 = Sunday.
  return weekday === 0 || weekday === 6;
}
export function isWorkingDay(date: string, holidays: ReadonlySet<string>): boolean {
  return !isWeekend(date) && !holidays.has(date);
}

/** How many days an application that entered its stage on `enteredOn` has waited by `today` (0 when it entered today or later). */
export function waitingDays(enteredOn: string, today: string, kind: WaitingDayKind, holidays: ReadonlySet<string> = new Set()): number {
  const from = dayNumber(enteredOn), to = dayNumber(today);
  if (to <= from) return 0;
  if (kind === 'calendar') return to - from;
  let n = 0;
  for (let d = from + 1; d <= to; d++) if (isWorkingDay(fromDayNumber(d), holidays)) n++;
  return n;
}

/**
 * The latest entry day on which an application has waited at least `days` days by `today`: entered on or before it ⇔
 * waitingDays(entered, today) ≥ days. Calendar days: today − days. Working days: the day before the `days`-th working day counted
 * back from today.
 */
export function waitingCutoff(today: string, days: number, kind: WaitingDayKind, holidays: ReadonlySet<string> = new Set()): string {
  if (!Number.isInteger(days) || days < 1) throw new Error('A waiting threshold is a whole number of days, at least 1.');
  const end = dayNumber(today);
  if (kind === 'calendar') return fromDayNumber(end - days);
  let counted = 0;
  for (let d = end; ; d--) {
    if (isWorkingDay(fromDayNumber(d), holidays)) counted++;
    if (counted === days) return fromDayNumber(d - 1);
  }
}

/** A rule's cutoff days for `today`: reminded when entered on or before `remindOn`; suggested when on or before `archiveOn`. */
export function ruleCutoffs(rule: Pick<WaitingRule, 'remindDays' | 'archiveDays' | 'dayKind'>, today: string, holidays: ReadonlySet<string> = new Set()): { remindOn: string; archiveOn: string | null } {
  return {
    remindOn: waitingCutoff(today, rule.remindDays, rule.dayKind, holidays),
    archiveOn: rule.archiveDays == null ? null : waitingCutoff(today, rule.archiveDays, rule.dayKind, holidays),
  };
}

/** Where `days` of waiting stands against the rule. */
export function waitingLevel(days: number, rule: Pick<WaitingRule, 'remindDays' | 'archiveDays'>): WaitingLevel {
  if (rule.archiveDays != null && days >= rule.archiveDays) return 'suggested';
  return days >= rule.remindDays ? 'waiting' : 'none';
}

/** The first day of the holiday window read for `today` (the first of January of the year HOLIDAY_LOOKBACK_DAYS ago). */
export function holidayWindowStart(today: string): string {
  return `${addDays(today, -HOLIDAY_LOOKBACK_DAYS).slice(0, 4)}-01-01`;
}

/** The board's waiting filter from ?waiting= (anything else: none). */
export function parseWaitingFilter(value: unknown): WaitingFilter | null {
  return typeof value === 'string' && (WAITING_FILTERS as readonly string[]).includes(value) ? (value as WaitingFilter) : null;
}

const wholeDays = (value: unknown): number | null | 'bad' => {
  if (value == null || value === '') return null;
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,4}$/.test(text)) return 'bad';
  return Number(text);
};

export type WaitingRuleInput = { remindDays?: unknown; archiveDays?: unknown; dayKind?: unknown };
/**
 * A rule's thresholds: the reminder 1–365 days (required), "suggest archiving" empty or more than the reminder and at most 730,
 * calendar or working days (required). Refused fields by form name.
 */
export function validateWaitingRule(input: WaitingRuleInput):
  | { ok: true; value: { remindDays: number; archiveDays: number | null; dayKind: WaitingDayKind } }
  | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const remind = wholeDays(input.remindDays);
  const archive = wholeDays(input.archiveDays);
  const kind = typeof input.dayKind === 'string' && (WAITING_DAY_KINDS as readonly string[]).includes(input.dayKind) ? (input.dayKind as WaitingDayKind) : null;
  const missing = [...(remind === null ? ['remindDays'] : []), ...(input.dayKind == null || input.dayKind === '' ? ['dayKind'] : [])];
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const bad: string[] = [];
  if (remind === 'bad' || remind === null || remind < 1 || remind > WAITING_REMIND_MAX) bad.push('remindDays');
  if (archive === 'bad' || (typeof archive === 'number' && (archive > WAITING_ARCHIVE_MAX || (typeof remind === 'number' && archive <= remind)))) bad.push('archiveDays');
  if (!kind) bad.push('dayKind');
  if (bad.length) return { ok: false, code: 'invalid_input', fields: bad };
  return { ok: true, value: { remindDays: remind as number, archiveDays: archive as number | null, dayKind: kind! } };
}
