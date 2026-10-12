import { rotationVersionOn, rotationDayOn, type RotationCycle } from '../core/week-pattern';
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
 * Full and half working weekdays both schedule the usual shift. A legacy usual shift with neither
 * a full pattern nor a half pattern schedules nothing; rest/off display retains its existing meaning.
 */

/** What is actually stored for one (employee, date): a shift, an explicit rest day, or nothing. */
export type AssignedCell = { kind: 'shift'; shiftId: string } | { kind: 'rest' } | null;

/** The person's usual (default) shift, with the weekly pattern that decides which days it covers. */
export type UsualShift = { shiftId: string; pattern: number[] | null; halfPattern?: number[] | null;
  noDefault?: boolean; rotations?: RotationCycle[] };

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

/** Every ISO date from `from` to `to`, inclusive, in order. Empty when `to` is before `from`. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

/** How many days a window covers, counting BOTH ends — 01→01 is one day, not zero. */
export const daysInWindow = (from: string, to: string): number =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/** The Monday–Sunday week containing `iso`. ISO weeks, matching `isoWeekdayOf` above and the EA 1955
 *  s.59 check, so "this week" means the same thing everywhere on this screen. */
export function weekRangeOf(iso: string): { from: string; to: string } {
  const from = addDaysIso(iso, -(isoWeekdayOf(iso) - 1));
  return { from, to: addDaysIso(from, 6) };
}

/**
 * ── THE THREE VIEWS (a57f0584 rev 2) ────────────────────────────────────────────────────────────
 *
 * Month, Week and a Custom From/To range are THREE WINDOWS OVER ONE READ, not three reads. The plan is
 * explicit about why: "a date cannot show one shift in one view and another in another". So the only
 * thing that varies between the views is the pair of dates resolved here; `rosterWindowView` takes that
 * pair and everything downstream — the grid, the export, the exceptions count, the Edit screen — is
 * unchanged and cannot disagree with itself.
 *
 * THE CAP, AND WHY IT IS 92. The plan flagged the open question ("cap the range or paginate — and say
 * which") and the answer is CAP, because the axis that is actually unbounded is COLUMNS. Rows are
 * already bounded — `paginateRows`/`ClientPager` page the employees. A date column costs `DATE_W` = 88px
 * of table plus one `<col>`, one `<th>` and one `<td>` per drawn row, and the widest window this screen
 * has ever been proven at is a 31-day month: 476 + 31×88 = 3,204px. 92 days is one calendar QUARTER —
 * the longest window an HR operator names in practice — and lands at 476 + 92×88 = 8,572px, about
 * 2.7× the proven figure. A year would be 32,596px and 365 columns per drawn row, which is precisely the
 * horizontal-scroll and pinned-offset pressure this round's `table-layout: fixed` + `<colgroup>` work
 * exists to remove.
 *
 * ⚠️ WHAT THE CAP DOES NOT BOUND, stated rather than implied: the pager's own "All" ceiling is 2,000
 * rows (lib/pagination#ALL_ROW_CEILING), and `cells` is serialised for every FILTERED employee rather
 * than every DRAWN one. So rows × days is still the product that decides the payload, and the cap only
 * bounds one of its two factors. That is true today at 31 days too; it is not made worse in kind, only
 * in degree, and fixing it is a pagination change rather than a windowing one.
 */
export const ROSTER_MAX_RANGE_DAYS = 92;

export type RosterViewKind = 'month' | 'week' | 'custom';
export const isRosterViewKind = (v: string | undefined | null): v is RosterViewKind =>
  v === 'month' || v === 'week' || v === 'custom';

/** The window the screen is showing: which view asked for it, and the two dates it resolved to.
 *  `month` is the month the window STARTS in — what the month picker and the export filename use. A
 *  week that straddles a month boundary starts in exactly one of them, and this says which. */
export type RosterWindow = { kind: RosterViewKind; from: string; to: string; month: string };

/**
 * A window, plus what was wrong with the request if anything. It ALWAYS yields a usable window: a screen
 * that refuses a hand-typed date by failing to render is worse than one that says what it did instead,
 * and `?from=2026-01-01&to=2026-12-31` must not be able to 500 the roster. The SERVICE refuses
 * independently (`assertRosterWindow` in core/roster.ts) so a caller that skips this resolver is still
 * stopped — a form is not a guard.
 */
export type ResolvedRosterWindow =
  | { ok: true; window: RosterWindow }
  | { ok: false; reason: 'backwards'; window: RosterWindow }
  | { ok: false; reason: 'too_wide'; askedDays: number; window: RosterWindow };

export function resolveRosterWindow(p: {
  view?: string | null;
  month?: string | null;
  from?: string | null;
  to?: string | null;
  /** Today in the tenant's timezone — passed in, never read from the clock here (lib/hr-date owns that). */
  today: string;
}): ResolvedRosterWindow {
  const monthWindow = (m: string, kind: RosterViewKind = 'month'): RosterWindow => {
    const r = monthRange(m);
    return { kind, from: r.from, to: r.to, month: m };
  };
  const kind: RosterViewKind = isRosterViewKind(p.view) ? p.view : 'month';
  const fallbackMonth = isMonthParam(p.month) ? p.month : monthOf(p.today);

  if (kind === 'week') {
    // Any date in the week identifies it; the resolver snaps to Monday. `<input type="week">` is
    // deliberately not used — it posts `YYYY-Www`, an ISO week-numbering year that disagrees with the
    // calendar year in the first and last days of January, which is a bug nobody would ever find.
    const anchor = isIsoDate(p.from ?? '') ? p.from! : p.today;
    const r = weekRangeOf(anchor);
    return { ok: true, window: { kind: 'week', from: r.from, to: r.to, month: monthOf(r.from) } };
  }

  if (kind === 'custom') {
    // No dates yet (the operator has just switched to Custom): open on the month, which is both inside
    // the cap and the window they were already looking at.
    if (!isIsoDate(p.from ?? '') || !isIsoDate(p.to ?? '')) return { ok: true, window: monthWindow(fallbackMonth, 'custom') };
    const from = p.from!;
    const to = p.to!;
    // Backwards: show the From date alone rather than guessing that the two were meant the other way
    // round. Swapping them silently would show a window nobody typed.
    if (to < from) return { ok: false, reason: 'backwards', window: { kind: 'custom', from, to: from, month: monthOf(from) } };
    const askedDays = daysInWindow(from, to);
    if (askedDays > ROSTER_MAX_RANGE_DAYS) {
      // Clamp forward from the date they typed, rather than snapping to a month boundary: it honours the
      // From they chose and the first day on screen is the first day they asked for.
      const clamped = addDaysIso(from, ROSTER_MAX_RANGE_DAYS - 1);
      return { ok: false, reason: 'too_wide', askedDays, window: { kind: 'custom', from, to: clamped, month: monthOf(from) } };
    }
    return { ok: true, window: { kind: 'custom', from, to, month: monthOf(from) } };
  }

  return { ok: true, window: monthWindow(fallbackMonth) };
}

/**
 * The window shifted one step in its own units: a month by a month, a week by seven days, and a custom
 * range by its OWN LENGTH — so ‹ on a fortnight gives the previous fortnight rather than an arbitrary
 * number of days. One stepper for three views, because three steppers is three chances to disagree.
 */
export function stepRosterWindow(w: RosterWindow, direction: 1 | -1): RosterWindow {
  if (w.kind === 'month') {
    const m = addMonths(w.month, direction);
    const r = monthRange(m);
    return { kind: 'month', from: r.from, to: r.to, month: m };
  }
  const span = daysInWindow(w.from, w.to);
  const from = addDaysIso(w.from, direction * span);
  return { kind: w.kind, from, to: addDaysIso(from, span - 1), month: monthOf(from) };
}

/**
 * THE LOCALE THE ROSTER FORMATS ITS DATES IN, and the one place the mapping is written.
 *
 * `en` in this app resolves to en-US, which orders a short date MONTH-FIRST: "Sep 01". Malaysia writes
 * dates day-first, and the approved plan's own example is "01 Sept, 02 Sept - never 01/09". The en-US
 * resolution is an accident of the catalogue being called `en`, not a product decision, so THIS
 * FORMATTER pins the region — en-GB, which yields exactly "01 Sept" — and the other five locales resolve
 * normally. It is still Intl deciding the words: no month table is hardcoded here or anywhere else.
 *
 * ⚠️ DELIBERATELY NARROW. It changes the roster's date formatters and nothing else. Whether `en` should
 * resolve to en-GB APP-WIDE is a product-wide question (every screen, every export, every PDF) and is
 * not this item's to answer. Shared by the roster, its Edit screen, its Exceptions screen and its export
 * so those four cannot print a date four ways.
 */
export const rosterDateLocale = (locale: string): string => (locale === 'en' ? 'en-GB' : locale);

/**
 * One cell, resolved. See the precedence note at the top of the file.
 */
export function resolveRosterCell(iso: string, assigned: AssignedCell, usual: UsualShift | null | undefined): ResolvedCell {
  if (assigned) return assigned.kind === 'shift' ? { kind: 'shift', shiftId: assigned.shiftId } : { kind: 'rest' };
  if (!usual) return { kind: 'none' };
  const version = rotationVersionOn(usual.rotations ?? [], iso);
  const day = version ? rotationDayOn(version, iso) : null;
  if (day) return day.kind === 'full' || day.kind === 'half'
    ? { kind: 'usual', shiftId: day.shiftId! } : day.kind === 'rest' ? { kind: 'rest' } : { kind: 'off' };
  if (usual.noDefault) return { kind: 'none' };
  const weekday=isoWeekdayOf(iso);
  return (usual.pattern?.includes(weekday)||usual.halfPattern?.includes(weekday)) ? { kind: 'usual', shiftId: usual.shiftId } : { kind: 'off' };
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
