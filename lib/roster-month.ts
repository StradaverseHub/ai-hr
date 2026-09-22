/**
 * Monthly roster grid — the pure, CLIENT-SAFE half (item 23390097).
 *
 * The roster screen, the export route, the Excel template and the upload analyzer all have to agree on
 * three things: which dates a month contains, what a cell SHOWS, and when the EA 1955 s.59 rest-day
 * warning fires. Those rules live here — no database, no next/*, no i18n — so the server component, the
 * client grid and the import service resolve every cell through the SAME function instead of three
 * lookalike copies.
 *
 * CELL PRECEDENCE mirrors core/attendance.ts's resolveShiftDisplay (private there, line ~1551), which is
 * itself scheduleFor()'s order — the grid must never disagree with the engine that measures attendance
 * against it:
 *
 *   rostered shift            → the shift's own code                        (kind 'shift')
 *   rostered rest day         → RD                                          (kind 'rest')
 *   default shift, pattern working day → that shift's code, GHOSTED in grey (kind 'usual')
 *   default shift, pattern rest day    → OFF                                (kind 'off')
 *   no default shift at all            → blank                              (kind 'none')
 *
 * The last two are ONE state in the engine (both resolve to "no shift"); they are split here only for
 * display, because "OFF — the usual shift does not work that day" and "nobody ever set a usual shift"
 * are different things to an HR administrator and the reporter asked to tell them apart.
 *
 * A default shift with a NULL weekly_pattern resolves to `off` on every date, exactly as
 * resolveShiftDisplay does (`def.pattern?.includes(...)` is false when pattern is null) — a usual shift
 * with no pattern schedules nothing.
 */

/** What is actually stored for one (employee, date): a shift, an explicit rest day, or nothing. */
export type AssignedCell = { kind: 'shift'; shiftId: string } | { kind: 'rest' } | null;

/** The person's usual (default) shift, with the weekly pattern that decides which days it covers. */
export type UsualShift = { shiftId: string; pattern: number[] | null };

/** What the cell shows. `usual` is the greyed ghost; `off`/`none` both mean "no shift is scheduled". */
export type ResolvedCell =
  | { kind: 'shift'; shiftId: string }
  | { kind: 'rest' }
  | { kind: 'usual'; shiftId: string }
  | { kind: 'off' }
  | { kind: 'none' };

const DAY_MS = 86_400_000;

export const isIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);
export const isMonthParam = (v: string | undefined | null): v is string => !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** 1 = Monday … 7 = Sunday. Byte-identical to core/attendance.ts's exported `isoWeekday`, restated here
 *  because that module reaches for the database and can never be imported by a client component. */
export const isoWeekdayOf = (iso: string): number => {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
};

export const isWeekendDate = (iso: string): boolean => isoWeekdayOf(iso) >= 6;

/** `2026-08-09` → `2026-08`. */
export const monthOf = (iso: string): string => iso.slice(0, 7);

/** Every ISO date in `YYYY-MM`, in order. */
export function monthDates(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of the NEXT month = this month's last day
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

/** First / last ISO date of `YYYY-MM`. */
export function monthRange(month: string): { from: string; to: string } {
  const dates = monthDates(month);
  return { from: dates[0], to: dates[dates.length - 1] };
}

/** Shift a `YYYY-MM` by whole months (negative = back). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const addDaysIso = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * One cell, resolved. See the precedence note at the top of the file.
 */
export function resolveRosterCell(iso: string, assigned: AssignedCell, usual: UsualShift | null | undefined): ResolvedCell {
  if (assigned) return assigned.kind === 'shift' ? { kind: 'shift', shiftId: assigned.shiftId } : { kind: 'rest' };
  if (!usual) return { kind: 'none' };
  return usual.pattern?.includes(isoWeekdayOf(iso)) ? { kind: 'usual', shiftId: usual.shiftId } : { kind: 'off' };
}

/** Is the person scheduled to WORK on this resolved cell? (`usual` counts — the ghost is a real schedule.) */
export const cellIsWorking = (c: ResolvedCell): boolean => c.kind === 'shift' || c.kind === 'usual';

/**
 * WHAT A RESOLVED CELL PRINTS — the grid's cell, the Edit screen's date tile, and anything else that
 * shows a day. It lives HERE, beside resolveRosterCell, for the reason the whole module exists: a second
 * rendition somewhere else is how one date comes to read RD in the grid and OFF in the editor.
 *
 * It takes `rd` and `off` as ARGUMENTS rather than reaching for next-intl, so this file stays free of
 * i18n and a server component and a client island can both call it (a57f0584 rev 2 — the Edit screen is
 * a server component and may not import a function out of a 'use client' module).
 */
export function rosterCellLabel(
  cell: ResolvedCell,
  codeOf: (shiftId: string) => string,
  rd: string,
  off: string,
): string {
  switch (cell.kind) {
    case 'shift':
      return codeOf(cell.shiftId);
    case 'rest':
      return rd;
    case 'usual':
      return codeOf(cell.shiftId);
    case 'off':
      return off;
    default:
      return '—';
  }
}

/**
 * EA 1955 s.59 — one rest day in every seven. The weekly grid could ask "does EVERY visible day carry a
 * shift?"; on a 31-column month that is almost never true, so the same question would silently stop
 * firing exactly when the screen got bigger. This is the rolling form: ANY seven CONSECUTIVE visible
 * dates with a working schedule on all seven and no rest day among them.
 *
 * A month shorter than seven visible dates cannot breach the rule, and returns false.
 */
export function breachesRestDayRule(dates: string[], resolve: (iso: string) => ResolvedCell): boolean {
  if (dates.length < 7) return false;
  let run = 0;
  for (const iso of dates) {
    run = cellIsWorking(resolve(iso)) ? run + 1 : 0;
    if (run >= 7) return true;
  }
  return false;
}

/** Grid key for one (employee, date). One spelling, so a lookup can never miss on a stray separator. */
export const cellKey = (employmentId: string, iso: string): string => `${employmentId}|${iso}`;

/** The code printed in a cell for a shift, falling back to the name — `shift.code` is nullable in the
 *  database (required by the service/form since R7, but legacy rows exist) and a blank cell would read
 *  as "not scheduled", which is a different fact. */
export const shiftCodeOf = (s: { code?: string | null; name: string } | undefined): string =>
  (s?.code && s.code.trim() !== '' ? s.code : s?.name) ?? '?';

/**
 * THE MACHINE HEADER of the Excel template. Never translated, in any locale, for the same reason
 * app/roster/export/route.ts hard-codes its payload headers (ADR-0047 §9): this row is READ BY A
 * PROGRAM, not by a person.
 *
 * The template used to build these four cells from `t('colEmployeeNo')` &c, and that made Download
 * Template unusable in every non-English locale. Measured, not theorised: lib/csv.ts#parseCsvRecords
 * normalises a heading to lower/trim/underscore, and core/roster-import.ts accepts only
 * employee_no | employee_number | employee_code | staff_id. `Employee No` normalises to `employee_no`;
 * the Malay `No. Pekerja` normalises to `no._pekerja` and the Chinese heading to itself. An admin
 * working in ms / zh / ta / th / vi downloaded the template, filled it in, uploaded it, and every row
 * came back rejected `missing_employee_no` — pointing at a column that was visibly populated.
 *
 * If a localised caption is ever wanted it belongs on a SECOND row the analyzer is taught to skip. It
 * does not belong here.
 */
export const ROSTER_TEMPLATE_ID_COLUMNS = ['Employee No', 'Employee Name', 'Department', 'Occupation'] as const;

export type RosterTemplateEmployee = {
  employmentId: string;
  name: string;
  code?: string | null;
  department?: string | null;
  occupation?: string | null;
};

/**
 * The Download Template payload: the month grid pre-filled with what is ROSTERED — never with the grey
 * ghosts, which have no stored row and must not be hardened into one by a round trip.
 *
 * Shared by app/roster/page.tsx and app/roster/import/page.tsx so the two buttons cannot drift, and so
 * there is exactly one place a translated heading could ever be reintroduced.
 */
export function buildRosterTemplate(p: {
  dates: string[];
  employees: RosterTemplateEmployee[];
  cells: Record<string, AssignedCell>;
  /** shiftId → the code the importer matches on. */
  shiftCode: (shiftId: string) => string;
}): { header: string[]; rows: string[][] } {
  return {
    header: [...ROSTER_TEMPLATE_ID_COLUMNS, ...p.dates],
    rows: p.employees.map((e) => [
      e.code ?? '',
      e.name,
      e.department ?? '',
      e.occupation ?? '',
      ...p.dates.map((iso) => {
        const c = p.cells[cellKey(e.employmentId, iso)] ?? null;
        return c == null ? '' : c.kind === 'rest' ? 'RD' : p.shiftCode(c.shiftId);
      }),
    ]),
  };
}
