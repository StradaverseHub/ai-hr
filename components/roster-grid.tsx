'use client';

/**
 * The MONTHLY roster grid (item 23390097) — employees down, every date of the month across.
 *
 * It replaces the seven-day window that came before it. What did NOT change: pick a "brush" (a shift, a
 * rest day, or Clear) from the legend and click a cell to assign it; each click calls a server action and
 * optimistically updates. What is new:
 *
 *   · one column per DATE of the chosen month, horizontally scrollable, with the employee and their
 *     occupation pinned to the left and Saturday+Sunday tinted;
 *   · cells print the shift's short CODE (RD for a rostered rest day, OFF for a day the usual shift does
 *     not work) instead of the shift's long name — a 48-character name cut off mid-word told nobody
 *     anything;
 *   · an un-rostered date shows the person's USUAL shift in grey, so the month reads as covered without
 *     rostering every day by hand. The precedence is lib/roster-month.ts's, which mirrors the engine's;
 *   · an Edit link per row opens that person's month on ITS OWN SCREEN (a57f0584 rev 2 — see below);
 *   · a date today or earlier prompts the administrator to confirm before it saves.
 *
 * WHO MAY CHANGE ANYTHING: only an HR administrator, and the grid now says so instead of implying
 * otherwise. Writing roster_assignment requires app.can_admin_employment → app.is_admin_for, so a
 * supervisor's write is refused by ROW-LEVEL SECURITY (PostgresError 42501) before any application check
 * runs. An earlier shape of this component greyed today-and-earlier for a supervisor and left tomorrow
 * onward CLICKABLE — a positive promise the database refuses; clicking tomorrow produced a toast carrying
 * a raw `Failed query: insert into "roster_assignment" …`. A supervisor now gets the month as READ-ONLY
 * TEXT — no brush, no bulk toolbar, no row Edit, no clickable cells — with one line saying a supervisor
 * views the roster and an HR administrator changes it. Widening that right is an RLS decision, not a
 * screen decision.
 *
 * THE s.59 CHECK CHANGED SHAPE, and it had to. The weekly grid asked "does EVERY visible day carry a
 * shift?" — on a 31-column month that is almost never true, so the warning would have silently stopped
 * firing at exactly the moment the screen got bigger. It is now the rolling any-seven-consecutive-days
 * form in lib/roster-month.ts#breachesRestDayRule.
 *
 * ── a57f0584 REV 2 — WHY THE PINNED BLOCK LOOKS DIFFERENT ──────────────────────────────────────────
 *
 * 1. THE OVERLAP WAS OURS, and it is the f728826a family: an offset derived from a width that nothing
 *    enforced. Every `<th>` took `sty(k)` — left + width + minWidth and NO maxWidth — while only some
 *    `<td>`s took `styTrunc(k)`. On a `border-collapse` table with no `table-layout`, a heading wider
 *    than its declared width GROWS the column, while every sticky `left` after it stays at the PINNED_W
 *    arithmetic; the frozen columns then paint on top of one another. It showed up while scrolling
 *    sideways and changed with the window size, which is why it read as a scrolling bug.
 *
 *    THE FIX IS THREE THINGS, and each of them alone is insufficient:
 *      · ONE accessor. `sty` and `styTrunc` are gone; `pinnedLayout().col()` is the only way to get a
 *        pinned cell's geometry and it always returns width, minWidth AND maxWidth (the f728826a
 *        three-way pin — a bare `width` is advisory on an auto-layout table). Header and body cannot
 *        take different halves of the contract because there are no longer two halves to take.
 *      · `table-layout: fixed` + a `<colgroup>` built from the SAME PINNED_W / DATE_W numbers, so the
 *        declared width is the used width and content can no longer widen a column at all.
 *      · `truncate` on every pinned cell INCLUDING the headings, so an over-long heading clips inside
 *        its own column instead of demanding room. A locale is what makes a heading long: "Employee"
 *        is eight characters in en and considerably more in ta and th.
 *
 * 2. ONE EMPLOYEE CELL. Employee No and Employee Name were two pinned columns saying one thing; they are
 *    now `AARON AZIZ (X003)` in a single cell. PINNED_W plus the two ORDER arrays remain the single
 *    source of the geometry, so this is ONE entry, not two.
 *    ⚠️ The parenthesised-code-AFTER-the-name order is the reporter's own words for this screen, and it
 *    runs the other way from `components/ui#EmployeeName` (38668d9b: id first, no brackets). The shared
 *    component is deliberately NOT used here for that reason; if the convention is ever reconciled, this
 *    is the call site that has to change with it.
 *
 * 3. COMPANY AND DEPARTMENT ARE GONE FROM THE ROSTER. ⚠️ THIS REVERSES r322's OWN PLAN, which said "A
 *    Company column appears whenever more than one company is on screen" — the reporter has since asked
 *    for both columns out. They are removed from PINNED_W and from both ORDER arrays rather than left as
 *    dead keys, because a key nothing renders is an offset nobody can check. `RosterMonthEmployee` keeps
 *    company / companyId (core/roster.ts): that read is shared with the export, whose columns are a
 *    separate decision nobody has asked about. A roster spanning every company no longer says whose
 *    employee a row is — the Company FILTER is the answer, and the plan said so before this was built.
 */
import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { paginateRows } from '@/lib/pagination';
import { ClientPager, useClientPageQuery } from '@/components/client-pager';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { assignCellAction, bulkAssignAction } from '@/app/roster/actions';
import { EmployeeCode } from '@/components/ui';
import { shiftChipClass } from '@/lib/shift-visual';
import {
  ROSTER_TEMPLATE_ID_COLUMNS,
  breachesRestDayRule,
  cellKey,
  rosterCellLabel,
  isWeekendDate,
  resolveRosterCell,
  shiftCodeOf,
  type AssignedCell,
  type ResolvedCell,
  type UsualShift,
} from '@/lib/roster-month';

/** 6340aecb — `color` is the shift's own DISPLAY-ONLY colour token (lib/shift-visual.ts). OPTIONAL, and
 *  ABSENT/NULL IS THE LOAD-BEARING CASE: a shift with no colour keeps the rotating position-keyed palette
 *  below, so a roster whose shifts have never been coloured renders exactly as it does today. */
export type ShiftLite = {
  id: string;
  code: string | null;
  name: string;
  startTime: string;
  endTime: string;
  color?: string | null;
};
/** a57f0584 rev 2 — `department` and `company` are NOT on this type any more. The grid stopped drawing
 *  those columns, and a field the grid cannot render is a field the page would keep serialising into the
 *  RSC payload for nothing. The columns the EXPORT and the Excel template need are read from
 *  `RosterMonthEmployee`, which still carries all four. */
export type GridEmployee = {
  employmentId: string;
  name: string;
  code?: string | null;
  occupation?: string | null;
};
export type GridDate = { iso: string; dow: string; day: string };
type Brush = string; // shiftId | 'rest' | 'clear'

/** The AUTOMATIC palette: a shift with no configured colour is tinted by its POSITION in the list, which
 *  is what every shift on this screen has always been. 6340aecb only renamed it — the entries, the order
 *  and the modulo are untouched, so an uncoloured roster is pixel-identical to before. */
const AUTO_SHIFT_COLORS = [
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
  'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300',
  'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300',
];

const hhmm = (t: string) => t.slice(0, 5);

/**
 * The pinned block. Widths are explicit because sticky columns need a known left offset each, and THIS
 * OBJECT IS THE ONLY PLACE ANY OF THOSE NUMBERS IS WRITTEN — the offsets are the running sum of it and
 * the `<colgroup>` is built from it, so the three can never disagree (f728826a).
 *
 * a57f0584 rev 2: `no` + `name` merged into `employee`; `company` and `dept` removed outright.
 */
const PINNED_W = { check: 36, employee: 248, occ: 132, edit: 60 } as const;
type PinnedKey = keyof typeof PINNED_W;
const EDIT_ORDER: PinnedKey[] = ['check', 'employee', 'occ', 'edit'];
/** Read-only drops the two columns that exist only in order to change something. */
const VIEW_ORDER: PinnedKey[] = ['employee', 'occ'];
/** a57f0584 rev 2 — wider than the 78 it was, because a date heading now reads "01 Sep" rather than
 *  "01/09", and in ta / th / vi the localised short month is longer again. */
const DATE_W = 88;
const HEAD_CLS = 'truncate bg-muted/50 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-wide';
const CELL_MUTED = 'truncate bg-background px-2 py-1.5 text-xs text-muted-foreground';

/**
 * Sticky left offsets, recomputed rather than constant because the read-only grid has fewer columns.
 *
 * ONE ACCESSOR, ON PURPOSE (a57f0584 rev 2). There used to be two — `sty` without a maxWidth and
 * `styTrunc` with one — and the headers took the first while the body took the second. That drift IS the
 * overlap: the heading grew its column and every `left` after it stayed where the arithmetic put it. A
 * single `col()` that always pins width three ways makes the two halves unable to disagree, and
 * test/a57f0584-roster-rev2.test.ts asserts that no second accessor comes back.
 */
function pinnedLayout(canEdit: boolean) {
  const order = canEdit ? EDIT_ORDER : VIEW_ORDER;
  const left = {} as Record<PinnedKey, number>;
  let x = 0;
  for (const k of order) {
    left[k] = x;
    x += PINNED_W[k];
  }
  return {
    width: x,
    order,
    col: (k: PinnedKey) => ({ left: left[k], width: PINNED_W[k], minWidth: PINNED_W[k], maxWidth: PINNED_W[k] }),
  };
}

export function RosterGrid({
  dates,
  employees,
  shifts,
  initial,
  usual,
  isAdmin,
  today,
  editQuery,
}: {
  dates: GridDate[];
  employees: GridEmployee[];
  shifts: ShiftLite[];
  initial: Record<string, AssignedCell>;
  /** employmentId → the person's usual (default) shift, for the grey ghost cells. */
  usual: Record<string, UsualShift>;
  /** HR administrator. THE ONLY ROLE THAT MAY CHANGE ANYTHING HERE — see the file header. False renders
   *  the whole month read-only rather than offering cells whose write RLS refuses. */
  isAdmin: boolean;
  today: string;
  /** a57f0584 rev 2 — the roster's own query string (month + filters), so Edit opens on the same month
   *  and Back returns to the same narrowing. A STRING and not a href-builder: a server component may hand
   *  a client island data or a server action, never an ordinary function. */
  editQuery: string;
}) {
  const t = useTranslations('roster');
  const [cells, setCells] = useState<Record<string, AssignedCell>>(initial);
  const [brush, setBrush] = useState<Brush>(shifts[0]?.id ?? 'rest');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [, startTx] = useTransition();

  const shiftById = useMemo(() => new Map(shifts.map((s) => [s.id, s])), [shifts]);
  const shiftIndex = (id: string) => shifts.findIndex((s) => s.id === id);
  // 6340aecb — the shift's OWN colour wins on the Duty Roster (the reporter's point 7); a shift that has
  // never been given one falls back to the automatic position palette, i.e. today's appearance. An
  // unrecognised stored token also falls back rather than rendering an unstyled cell — shiftChipClass
  // returns null for anything outside the closed palette.
  const shiftColor = (id: string) =>
    shiftChipClass(shiftById.get(id)?.color) ?? AUTO_SHIFT_COLORS[Math.max(0, shiftIndex(id)) % AUTO_SHIFT_COLORS.length];
  const codeOf = (id: string) => shiftCodeOf(shiftById.get(id));
  const cellFromBrush = (br: Brush): AssignedCell =>
    br === 'rest' ? { kind: 'rest' } : br === 'clear' ? null : { kind: 'shift', shiftId: br };

  const resolve = (employmentId: string, iso: string): ResolvedCell =>
    resolveRosterCell(iso, cells[cellKey(employmentId, iso)] ?? null, usual[employmentId] ?? null);

  /** Only an HR administrator can change the roster AT ALL — the database, not this flag, is the guard. */
  const canEdit = isAdmin;
  const isPast = (iso: string) => iso <= today;
  /**
   * The half of the past-date requirement that does work: confirm before overwriting a day that has
   * probably already been attended. Only ever reached by an administrator.
   *
   * a57f0584 rev 2 KEPT THIS `window.confirm` DELIBERATELY. The confirm that went away with the row
   * editor was the EDIT flow's ("set N dates for this employee?"), and it went away because the edit
   * moved to a screen of its own where the Apply button says what it will do. This one is the PAST-DATE
   * rule (requirement 9), it fires on a single click on a cell that is already painted, and there is no
   * screen to move it to: a page transition per painted cell is not a confirmation, it is a different
   * product. Replacing it with a dialog component is a separate change to make on purpose.
   */
  const confirmPast = (isoDates: string[]): boolean => {
    const past = isoDates.filter(isPast);
    if (past.length === 0) return true;
    return window.confirm(t('pastConfirm', { count: past.length }));
  };

  const paint = (employmentId: string, iso: string) => {
    if (!canEdit) return;
    if (!confirmPast([iso])) return;
    const key = cellKey(employmentId, iso);
    const prev = cells[key] ?? null;
    setCells((c) => ({ ...c, [key]: cellFromBrush(brush) }));
    startTx(async () => {
      const r = await assignCellAction({ employmentId, shiftDate: iso, brush });
      if (!r.ok) {
        setCells((c) => ({ ...c, [key]: prev }));
        toast.error(r.error);
      }
    });
  };

  const applyBulk = () => {
    if (!canEdit || selected.size === 0) return;
    const empIds = [...selected];
    const isoDates = dates.map((d) => d.iso);
    if (!confirmPast(isoDates)) return;
    const snapshot = cells;
    setCells((c) => {
      const n = { ...c };
      for (const e of empIds) for (const d of isoDates) n[cellKey(e, d)] = cellFromBrush(brush);
      return n;
    });
    startTx(async () => {
      const r = await bulkAssignAction({ employmentIds: empIds, shiftDates: isoDates, brush });
      if (!r.ok) {
        setCells(snapshot);
        toast.error(r.error);
      } else toast.success(t('bulkDone', { n: empIds.length }));
    });
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const q = useClientPageQuery();
  const { rows: pageEmployees, state } = paginateRows(employees, q);
  // Selection covers the rows you can see, for the same reason as the feedback table: a brush applied
  // to "everyone" must mean everyone on screen, not everyone in the roster.
  const selectedOnPage = pageEmployees.filter((e) => selected.has(e.employmentId));
  const allSelected = pageEmployees.length > 0 && selectedOnPage.length === pageEmployees.length;

  const noRestDay = (employmentId: string) =>
    breachesRestDayRule(
      dates.map((d) => d.iso),
      (iso) => resolve(employmentId, iso),
    );

  /** a57f0584 rev 2 — Edit is a LINK to that person's own screen, not a panel toggled at the foot of this
   *  page. The month and the filters ride along so the screen opens on what is in front of the
   *  administrator, and its Back / Save both come back here. */
  const editHref = (employmentId: string) =>
    `/roster/edit/${employmentId}${editQuery ? `?${editQuery}` : ''}`;

  /** A chip is a BRUSH for an administrator and just the key-to-the-codes for everybody else — the
   *  read-only grid keeps the legend (the codes still have to be readable) but not the palette. */
  const legendChip = (value: Brush | null, label: string, hint: string, cls: string) => {
    const content = (
      <>
        <span className="font-semibold">{label}</span>
        {hint && <span className="ml-1 font-normal opacity-75">{hint}</span>}
      </>
    );
    if (value == null || !canEdit)
      return (
        <span key={value ?? label} className={`rounded-full border px-2.5 py-1 text-xs ${cls}`}>
          {content}
        </span>
      );
    return (
      <button
        key={value}
        type="button"
        onClick={() => setBrush(value)}
        className={`rounded-full border px-2.5 py-1 text-xs transition ${cls} ${
          brush === value ? 'ring-2 ring-offset-1 ring-foreground/40' : 'opacity-80 hover:opacity-100'
        }`}
      >
        {content}
      </button>
    );
  };

  const pinned = pinnedLayout(canEdit);

  return (
    <div className="space-y-3">
      {/* Legend — for an administrator it doubles as the brush palette: the code you can read is the code
          you paint with. Read-only, it is only the key. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('legend')}</span>
        {shifts.map((s) => legendChip(s.id, shiftCodeOf(s), `${hhmm(s.startTime)}–${hhmm(s.endTime)}`, shiftColor(s.id)))}
        {legendChip('rest', t('rdCode'), t('restDay'), 'bg-muted text-muted-foreground')}
        {legendChip('clear', t('clear'), t('clearHint'), 'bg-background text-muted-foreground')}
        {legendChip(null, t('offCode'), t('offHint'), 'bg-background text-muted-foreground/70 border-dashed')}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {canEdit ? (
          <>
            <span>{t('selectedCount', { n: selected.size })}</span>
            <button
              type="button"
              onClick={applyBulk}
              disabled={selected.size === 0}
              className="rounded-md border border-border px-2 py-1 font-medium text-foreground enabled:hover:bg-muted disabled:opacity-40"
            >
              {t('applyToMonth')}
            </button>
          </>
        ) : (
          /* The one line of copy that stands in for every affordance a supervisor cannot use. */
          <span className="rounded-md border border-border bg-muted/40 px-2 py-1 font-medium text-foreground">{t('viewOnly')}</span>
        )}
        <span className="ml-auto">{t('ghostHint')}</span>
      </div>

      {/* Grid */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table
          className="border-collapse text-sm"
          style={{ tableLayout: 'fixed', minWidth: pinned.width + dates.length * DATE_W }}
        >
          {/* a57f0584 — THE HALF OF THE OVERLAP FIX A STYLE ATTRIBUTE CANNOT DO ALONE. On an auto-layout
              table the browser may still grow a column to fit its content; with `table-layout: fixed`
              these declared widths ARE the used widths, so a long heading or a long name clips instead of
              pushing every sticky offset after it out of place. Built from PINNED_W and DATE_W — the same
              numbers the offsets are summed from, never a second list. */}
          <colgroup>
            {pinned.order.map((k) => (
              <col key={k} style={{ width: PINNED_W[k] }} />
            ))}
            {dates.map((d) => (
              <col key={d.iso} style={{ width: DATE_W }} />
            ))}
          </colgroup>
          <thead>
            <tr className="bg-muted/50">
              {canEdit && (
                <th className={`sticky z-20 ${HEAD_CLS}`} style={pinned.col('check')}>
                  <input
                    type="checkbox"
                    aria-label={t('selectAll')}
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(pageEmployees.map((e) => e.employmentId)))}
                  />
                </th>
              )}
              <th className={`sticky z-20 ${HEAD_CLS}`} style={pinned.col('employee')}>
                {t('colEmployee')}
              </th>
              <th className={`sticky z-20 ${HEAD_CLS} ${canEdit ? '' : 'border-r border-border'}`} style={pinned.col('occ')}>
                {t('colOccupation')}
              </th>
              {canEdit && (
                <th className={`sticky z-20 border-r border-border ${HEAD_CLS}`} style={pinned.col('edit')}>
                  {t('colEdit')}
                </th>
              )}
              {dates.map((d) => {
                const weekend = isWeekendDate(d.iso);
                return (
                  <th
                    key={d.iso}
                    className={`px-1 py-2 text-center font-medium ${weekend ? 'bg-amber-50 dark:bg-amber-500/10' : ''}`}
                    style={{ width: DATE_W, minWidth: DATE_W, maxWidth: DATE_W }}
                  >
                    <div className="truncate text-[11px] tabular-nums">{d.day}</div>
                    <div className="truncate text-[10px] font-normal text-muted-foreground">{d.dow}</div>
                    {d.iso === today && (
                      <div className="truncate text-[9px] font-semibold uppercase text-primary">{t('todayLabel')}</div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageEmployees.map((e) => (
              <tr key={e.employmentId}>
                {canEdit && (
                  <td className="sticky z-10 truncate bg-background px-2 py-1.5" style={pinned.col('check')}>
                    <input
                      type="checkbox"
                      aria-label={e.name}
                      checked={selected.has(e.employmentId)}
                      onChange={() => toggle(e.employmentId)}
                    />
                  </td>
                )}
                {/* ONE cell for the person: AARON AZIZ (X003). See note 2 in the file header for why the
                    code reads after the name here and not before it as EmployeeName has it elsewhere. */}
                <td
                  className="sticky z-10 truncate bg-background px-2 py-1.5 font-medium"
                  style={pinned.col('employee')}
                  title={e.code ? `${e.name} (${e.code})` : e.name}
                >
                  <span className="flex min-w-0 items-baseline gap-1">
                    <span className="truncate">{e.name}</span>
                    {e.code && (
                      <span className="shrink-0 font-normal text-muted-foreground">
                        (<EmployeeCode code={e.code} />)
                      </span>
                    )}
                    {noRestDay(e.employmentId) && (
                      <span
                        title={t('noRestWarningHint')}
                        className="shrink-0 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-400"
                      >
                        {t('noRest')}
                      </span>
                    )}
                  </span>
                </td>
                <td
                  className={`sticky z-10 ${CELL_MUTED} ${canEdit ? '' : 'border-r border-border'}`}
                  style={pinned.col('occ')}
                  title={e.occupation ?? ''}
                >
                  {e.occupation ?? '—'}
                </td>
                {canEdit && (
                  <td className="sticky z-10 truncate border-r border-border bg-background px-2 py-1.5" style={pinned.col('edit')}>
                    <Link
                      href={editHref(e.employmentId)}
                      className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {t('colEdit')}
                    </Link>
                  </td>
                )}
                {dates.map((d) => {
                  const cell = resolve(e.employmentId, d.iso);
                  const weekend = isWeekendDate(d.iso);
                  const label = rosterCellLabel(cell, codeOf, t('rdCode'), t('offCode'));
                  const box = `min-h-[26px] w-full truncate rounded px-0.5 py-1 text-[11px] font-medium ${cellClass(cell, shiftColor)}`;
                  return (
                    <td
                      key={d.iso}
                      className={`p-0.5 text-center ${weekend ? 'bg-amber-50 dark:bg-amber-500/10' : ''}`}
                      style={{ width: DATE_W, minWidth: DATE_W, maxWidth: DATE_W }}
                    >
                      {canEdit ? (
                        <button
                          type="button"
                          onClick={() => paint(e.employmentId, d.iso)}
                          className={`${box} transition hover:ring-1 hover:ring-foreground/30`}
                        >
                          {label}
                        </button>
                      ) : (
                        // TEXT, not a disabled control. A supervisor is not momentarily blocked from
                        // painting this cell — a supervisor does not paint cells, and a greyed-out button
                        // says "not yet" where the truth is "not you".
                        <span className={`${box} block`}>{label}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ClientPager state={state} />
    </div>
  );
}

function cellClass(cell: ResolvedCell, shiftColor: (id: string) => string): string {
  switch (cell.kind) {
    case 'shift':
      return shiftColor(cell.shiftId);
    case 'rest':
      return 'bg-muted text-muted-foreground';
    // The GHOST: same code, deliberately grey and un-filled, because nothing is stored for this date.
    case 'usual':
      return 'text-muted-foreground/70 italic';
    case 'off':
      return 'text-muted-foreground/50';
    default:
      return 'text-muted-foreground/30';
  }
}



/**
 * "Download Template" — the month as a REAL .xlsx workbook, built in the browser.
 *
 * Two properties earn the SheetJS round trip rather than a CSV:
 *   · every column is pre-formatted as TEXT, so Excel cannot turn `0012` into the number 12 the moment
 *     HR types it (the leading-zero destruction lib/import-template-xlsx.ts exists to document), and a
 *     shift code that happens to be all digits survives too;
 *   · a second Notes sheet spells out the cell vocabulary — blank means leave alone, RD is a rest day,
 *     OFF clears — so the file explains itself away from this screen.
 *
 * SheetJS is dynamically imported: the ~400 KB library never enters the initial bundle and never
 * reaches a server action. The rows are prepared on the SERVER (lib/roster-month#buildRosterTemplate)
 * and carry only the dates that are actually rostered — never the grey ghosts, which have no stored row
 * and must not be hardened into one by a round trip.
 *
 * IT TAKES `dates`, NOT A HEADER, ON PURPOSE. The four identity headings are the MACHINE header and are
 * built here from ROSTER_TEMPLATE_ID_COLUMNS, so no caller can hand this button `t('colEmployeeNo')`
 * again — which is exactly what made the download/upload round trip impossible in ms, zh, ta, th and vi.
 */
export function RosterTemplateButton({
  dates,
  rows,
  month,
  codes,
  label,
  notesTitle,
  notes,
  failedLabel,
}: {
  /** The ISO dates of the month, in order — the date half of the header. */
  dates: string[];
  rows: string[][];
  month: string;
  codes: string[];
  label: string;
  notesTitle: string;
  notes: string[];
  failedLabel: string;
}) {
  const header = [...ROSTER_TEMPLATE_ID_COLUMNS, ...dates];
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const [{ buildXlsx }, { buildInstructionRows }] = await Promise.all([
        import('@/lib/spreadsheet'),
        import('@/lib/import-template-xlsx'),
      ]);
      const bytes = await buildXlsx(header, rows, {
        sheetName: 'Roster',
        textColumns: header.map((_, i) => i),
        extraSheets: [
          { name: 'Notes', rows: buildInstructionRows(notesTitle, [...notes, codes.join(', ') || '—']) },
        ],
      });
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `roster-${month}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(failedLabel);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void download()}
      className="rounded-md border border-border px-2.5 py-1 text-sm text-foreground hover:bg-muted disabled:opacity-50"
    >
      {label}
    </button>
  );
}
