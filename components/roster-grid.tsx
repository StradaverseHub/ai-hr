'use client';

/**
 * The MONTHLY roster grid (item 23390097) — employees down, every date of the month across.
 *
 * It replaces the seven-day window that came before it. What did NOT change: pick a "brush" (a shift, a
 * rest day, or Clear) from the legend and click a cell to assign it; each click calls a server action and
 * optimistically updates. What is new:
 *
 *   · one column per DATE of the chosen month, horizontally scrollable, with Employee No / Name /
 *     Department / Occupation pinned to the left and Saturday+Sunday tinted;
 *   · cells print the shift's short CODE (RD for a rostered rest day, OFF for a day the usual shift does
 *     not work) instead of the shift's long name — a 48-character name cut off mid-word told nobody
 *     anything;
 *   · an un-rostered date shows the person's USUAL shift in grey, so the month reads as covered without
 *     rostering every day by hand. The precedence is lib/roster-month.ts's, which mirrors the engine's;
 *   · an Edit link per row opens that person's month for a tick-several-dates-set-them-all edit;
 *   · dates today or earlier are HR-administrator-only, and confirm before they save.
 *
 * THE s.59 CHECK CHANGED SHAPE, and it had to. The weekly grid asked "does EVERY visible day carry a
 * shift?" — on a 31-column month that is almost never true, so the warning would have silently stopped
 * firing at exactly the moment the screen got bigger. It is now the rolling any-seven-consecutive-days
 * form in lib/roster-month.ts#breachesRestDayRule.
 */
import { useMemo, useState, useTransition } from 'react';
import { paginateRows } from '@/lib/pagination';
import { ClientPager, useClientPageQuery } from '@/components/client-pager';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { assignCellAction, bulkAssignAction, rowAssignAction } from '@/app/roster/actions';
import { EmployeeCode } from '@/components/ui';
import {
  breachesRestDayRule,
  cellKey,
  isWeekendDate,
  resolveRosterCell,
  shiftCodeOf,
  type AssignedCell,
  type ResolvedCell,
  type UsualShift,
} from '@/lib/roster-month';

export type ShiftLite = { id: string; code: string | null; name: string; startTime: string; endTime: string };
export type GridEmployee = {
  employmentId: string;
  name: string;
  code?: string | null;
  department?: string | null;
  occupation?: string | null;
};
export type GridDate = { iso: string; dow: string; day: string };
type Brush = string; // shiftId | 'rest' | 'clear'

const SHIFT_COLORS = [
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
  'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300',
  'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-300',
];

const hhmm = (t: string) => t.slice(0, 5);

/** The pinned block. Widths are explicit because sticky columns need a known left offset each. */
const PINNED = [
  { key: 'check', w: 36 },
  { key: 'no', w: 96 },
  { key: 'name', w: 190 },
  { key: 'dept', w: 132 },
  { key: 'occ', w: 132 },
  { key: 'edit', w: 54 },
] as const;
const LEFT_OF = PINNED.reduce<number[]>((acc, c, i) => [...acc, i === 0 ? 0 : acc[i - 1] + PINNED[i - 1].w], []);
const DATE_W = 78;

export function RosterGrid({
  dates,
  employees,
  shifts,
  initial,
  usual,
  isAdmin,
  today,
  companyName,
}: {
  dates: GridDate[];
  employees: GridEmployee[];
  shifts: ShiftLite[];
  initial: Record<string, AssignedCell>;
  /** employmentId → the person's usual (default) shift, for the grey ghost cells. */
  usual: Record<string, UsualShift>;
  /** HR administrator: may write a date that is today or earlier (after confirming). */
  isAdmin: boolean;
  today: string;
  companyName: string;
}) {
  const t = useTranslations('roster');
  const [cells, setCells] = useState<Record<string, AssignedCell>>(initial);
  const [brush, setBrush] = useState<Brush>(shifts[0]?.id ?? 'rest');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [, startTx] = useTransition();

  const shiftById = useMemo(() => new Map(shifts.map((s) => [s.id, s])), [shifts]);
  const shiftIndex = (id: string) => shifts.findIndex((s) => s.id === id);
  const shiftColor = (id: string) => SHIFT_COLORS[Math.max(0, shiftIndex(id)) % SHIFT_COLORS.length];
  const codeOf = (id: string) => shiftCodeOf(shiftById.get(id));
  const cellFromBrush = (br: Brush): AssignedCell =>
    br === 'rest' ? { kind: 'rest' } : br === 'clear' ? null : { kind: 'shift', shiftId: br };

  const resolve = (employmentId: string, iso: string): ResolvedCell =>
    resolveRosterCell(iso, cells[cellKey(employmentId, iso)] ?? null, usual[employmentId] ?? null);

  /** The affordance half of the past-date rule; the server action re-checks it (lib/authz is the guard). */
  const isPast = (iso: string) => iso <= today;
  const locked = (iso: string) => isPast(iso) && !isAdmin;
  /** Admins confirm before overwriting a day that has probably already been attended. */
  const confirmPast = (isoDates: string[]): boolean => {
    const past = isoDates.filter(isPast);
    if (past.length === 0) return true;
    if (!isAdmin) {
      toast.error(t('pastLocked'));
      return false;
    }
    return window.confirm(t('pastConfirm', { count: past.length }));
  };

  const paint = (employmentId: string, iso: string) => {
    if (locked(iso)) {
      toast.error(t('pastLocked'));
      return;
    }
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
    if (selected.size === 0) return;
    const empIds = [...selected];
    // Non-admins can only touch tomorrow onward; rather than refusing the whole action, the writable
    // dates go through and the count in the toast says how many.
    const isoDates = dates.map((d) => d.iso).filter((iso) => !locked(iso));
    if (isoDates.length === 0) {
      toast.error(t('pastLocked'));
      return;
    }
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

  const applyRow = (employmentId: string, isoDates: string[], rowBrush: Brush) => {
    const writable = isoDates.filter((iso) => !locked(iso));
    if (writable.length === 0) {
      toast.error(t('pastLocked'));
      return;
    }
    if (!window.confirm(t('rowConfirm', { count: writable.length }))) return;
    if (!confirmPast(writable)) return;
    const snapshot = cells;
    setCells((c) => {
      const n = { ...c };
      for (const d of writable) n[cellKey(employmentId, d)] = cellFromBrush(rowBrush);
      return n;
    });
    startTx(async () => {
      const r = await rowAssignAction({ employmentId, shiftDates: writable, brush: rowBrush });
      if (!r.ok) {
        setCells(snapshot);
        toast.error(r.error);
      } else {
        toast.success(t('rowApplied', { count: writable.length }));
        setEditing(null);
      }
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

  const legendChip = (value: Brush | null, label: string, hint: string, cls: string) => {
    const content = (
      <>
        <span className="font-semibold">{label}</span>
        {hint && <span className="ml-1 font-normal opacity-75">{hint}</span>}
      </>
    );
    if (value == null)
      return (
        <span key={label} className={`rounded-full border px-2.5 py-1 text-xs ${cls}`}>
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

  const editingEmployee = employees.find((e) => e.employmentId === editing) ?? null;

  return (
    <div className="space-y-3">
      {/* Legend — also the brush palette: the code you can read is the code you paint with. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('legend')}</span>
        {shifts.map((s) => legendChip(s.id, shiftCodeOf(s), `${hhmm(s.startTime)}–${hhmm(s.endTime)}`, shiftColor(s.id)))}
        {legendChip('rest', t('rdCode'), t('restDay'), 'bg-muted text-muted-foreground')}
        {legendChip('clear', t('clear'), t('clearHint'), 'bg-background text-muted-foreground')}
        {legendChip(null, t('offCode'), t('offHint'), 'bg-background text-muted-foreground/70 border-dashed')}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t('selectedCount', { n: selected.size })}</span>
        <button
          type="button"
          onClick={applyBulk}
          disabled={selected.size === 0}
          className="rounded-md border border-border px-2 py-1 font-medium text-foreground enabled:hover:bg-muted disabled:opacity-40"
        >
          {t('applyToMonth')}
        </button>
        <span className="ml-auto">{t('ghostHint')}</span>
      </div>

      {/* Grid */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="border-collapse text-sm" style={{ minWidth: LEFT_OF[5] + PINNED[5].w + dates.length * DATE_W }}>
          <thead>
            <tr className="bg-muted/50">
              <th
                className="sticky z-20 bg-muted/50 px-2 py-2 text-left font-medium"
                style={{ left: LEFT_OF[0], width: PINNED[0].w, minWidth: PINNED[0].w }}
              >
                <input
                  type="checkbox"
                  aria-label={t('selectAll')}
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(pageEmployees.map((e) => e.employmentId)))}
                />
              </th>
              <th
                className="sticky z-20 bg-muted/50 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-wide"
                style={{ left: LEFT_OF[1], width: PINNED[1].w, minWidth: PINNED[1].w }}
              >
                {t('colEmployeeNo')}
              </th>
              <th
                className="sticky z-20 bg-muted/50 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-wide"
                style={{ left: LEFT_OF[2], width: PINNED[2].w, minWidth: PINNED[2].w }}
              >
                {t('colEmployeeName')}
              </th>
              <th
                className="sticky z-20 bg-muted/50 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-wide"
                style={{ left: LEFT_OF[3], width: PINNED[3].w, minWidth: PINNED[3].w }}
              >
                {t('colDepartment')}
              </th>
              <th
                className="sticky z-20 bg-muted/50 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-wide"
                style={{ left: LEFT_OF[4], width: PINNED[4].w, minWidth: PINNED[4].w }}
              >
                {t('colOccupation')}
              </th>
              <th
                className="sticky z-20 border-r border-border bg-muted/50 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-wide"
                style={{ left: LEFT_OF[5], width: PINNED[5].w, minWidth: PINNED[5].w }}
              >
                {t('colEdit')}
              </th>
              {dates.map((d) => {
                const weekend = isWeekendDate(d.iso);
                return (
                  <th
                    key={d.iso}
                    className={`px-1 py-2 text-center font-medium ${weekend ? 'bg-amber-50 dark:bg-amber-500/10' : ''}`}
                    style={{ width: DATE_W, minWidth: DATE_W }}
                  >
                    <div className="text-[11px] tabular-nums">{d.day}</div>
                    <div className="text-[10px] font-normal text-muted-foreground">{d.dow}</div>
                    {d.iso === today && (
                      <div className="text-[9px] font-semibold uppercase text-primary">{t('todayLabel')}</div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageEmployees.map((e) => (
              <tr key={e.employmentId}>
                <td
                  className="sticky z-10 bg-background px-2 py-1.5"
                  style={{ left: LEFT_OF[0], width: PINNED[0].w, minWidth: PINNED[0].w }}
                >
                  <input
                    type="checkbox"
                    aria-label={e.name}
                    checked={selected.has(e.employmentId)}
                    onChange={() => toggle(e.employmentId)}
                  />
                </td>
                <td
                  className="sticky z-10 bg-background px-2 py-1.5"
                  style={{ left: LEFT_OF[1], width: PINNED[1].w, minWidth: PINNED[1].w }}
                >
                  <EmployeeCode code={e.code} />
                </td>
                <td
                  className="sticky z-10 truncate bg-background px-2 py-1.5 font-medium"
                  style={{ left: LEFT_OF[2], width: PINNED[2].w, minWidth: PINNED[2].w, maxWidth: PINNED[2].w }}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{e.name}</span>
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
                  className="sticky z-10 truncate bg-background px-2 py-1.5 text-xs text-muted-foreground"
                  style={{ left: LEFT_OF[3], width: PINNED[3].w, minWidth: PINNED[3].w, maxWidth: PINNED[3].w }}
                >
                  {e.department ?? '—'}
                </td>
                <td
                  className="sticky z-10 truncate bg-background px-2 py-1.5 text-xs text-muted-foreground"
                  style={{ left: LEFT_OF[4], width: PINNED[4].w, minWidth: PINNED[4].w, maxWidth: PINNED[4].w }}
                >
                  {e.occupation ?? '—'}
                </td>
                <td
                  className="sticky z-10 border-r border-border bg-background px-2 py-1.5"
                  style={{ left: LEFT_OF[5], width: PINNED[5].w, minWidth: PINNED[5].w }}
                >
                  <button
                    type="button"
                    onClick={() => setEditing(editing === e.employmentId ? null : e.employmentId)}
                    className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {t('colEdit')}
                  </button>
                </td>
                {dates.map((d) => {
                  const cell = resolve(e.employmentId, d.iso);
                  const weekend = isWeekendDate(d.iso);
                  const dis = locked(d.iso);
                  return (
                    <td
                      key={d.iso}
                      className={`p-0.5 text-center ${weekend ? 'bg-amber-50 dark:bg-amber-500/10' : ''}`}
                      style={{ width: DATE_W, minWidth: DATE_W }}
                    >
                      <button
                        type="button"
                        onClick={() => paint(e.employmentId, d.iso)}
                        disabled={dis}
                        title={dis ? t('pastLocked') : undefined}
                        className={`min-h-[26px] w-full truncate rounded px-0.5 py-1 text-[11px] font-medium transition ${
                          dis ? 'cursor-not-allowed opacity-60' : 'hover:ring-1 hover:ring-foreground/30'
                        } ${cellClass(cell, shiftColor)}`}
                      >
                        {cellLabel(cell, codeOf, t('rdCode'), t('offCode'))}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ClientPager state={state} />

      {editingEmployee && (
        <RowEditor
          employee={editingEmployee}
          dates={dates}
          shifts={shifts}
          today={today}
          isAdmin={isAdmin}
          resolve={(iso) => resolve(editingEmployee.employmentId, iso)}
          codeOf={codeOf}
          onCancel={() => setEditing(null)}
          onApply={(isoDates, rowBrush) => applyRow(editingEmployee.employmentId, isoDates, rowBrush)}
          companyName={companyName}
        />
      )}
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

function cellLabel(cell: ResolvedCell, codeOf: (id: string) => string, rd: string, off: string): string {
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
 * One person's month: tick several dates, choose one shift, confirm, save.
 *
 * It exists because the reporter's own screen has an Edit link per row, and because setting eight
 * Saturdays for one person by clicking eight cells is eight round trips. The write goes through
 * rowAssignAction → assignRosterRow, which loops the PER-DATE primitives so the Audit Trail gets one
 * reversible entry per date with the shift before and after — the bulk primitives would have written a
 * single summary with no previous shift in it.
 */
function RowEditor({
  employee,
  dates,
  shifts,
  today,
  isAdmin,
  resolve,
  codeOf,
  onCancel,
  onApply,
  companyName,
}: {
  employee: GridEmployee;
  dates: GridDate[];
  shifts: ShiftLite[];
  today: string;
  isAdmin: boolean;
  resolve: (iso: string) => ResolvedCell;
  codeOf: (id: string) => string;
  onCancel: () => void;
  onApply: (isoDates: string[], brush: Brush) => void;
  companyName: string;
}) {
  const t = useTranslations('roster');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rowBrush, setRowBrush] = useState<Brush>(shifts[0]?.id ?? 'rest');
  const writable = dates.filter((d) => isAdmin || d.iso > today);

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t('rowEditTitle', { name: employee.name })}
          <span className="ml-2 text-xs font-normal text-muted-foreground">{companyName}</span>
        </h3>
        <button type="button" onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground">
          {t('rowEditClose')}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('rowEditHint')}</p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {dates.map((d) => {
          const dis = !isAdmin && d.iso <= today;
          const on = picked.has(d.iso);
          return (
            <label
              key={d.iso}
              className={`flex min-w-[68px] cursor-pointer flex-col items-center rounded border px-1.5 py-1 text-[11px] ${
                dis ? 'cursor-not-allowed opacity-40' : on ? 'border-primary bg-primary/15' : 'border-border bg-background'
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                disabled={dis}
                checked={on}
                onChange={() =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (n.has(d.iso)) n.delete(d.iso);
                    else n.add(d.iso);
                    return n;
                  })
                }
              />
              <span className="tabular-nums">{d.day}</span>
              <span className="text-[10px] text-muted-foreground">{d.dow}</span>
              <span className="truncate text-[10px] text-muted-foreground">
                {cellLabel(resolve(d.iso), codeOf, t('rdCode'), t('offCode'))}
              </span>
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setPicked(new Set(writable.map((d) => d.iso)))}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          {t('selectAllDates')}
        </button>
        <button
          type="button"
          onClick={() => setPicked(new Set())}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          {t('clearDates')}
        </button>
        <select
          value={rowBrush}
          onChange={(ev) => setRowBrush(ev.target.value)}
          aria-label={t('legend')}
          className="h-8 rounded-md border border-input bg-card px-2 text-xs"
        >
          {shifts.map((s) => (
            <option key={s.id} value={s.id}>
              {codeOf(s.id)} · {s.name}
            </option>
          ))}
          <option value="rest">{t('restDay')}</option>
          <option value="clear">{t('clear')}</option>
        </select>
        <button
          type="button"
          disabled={picked.size === 0}
          onClick={() => onApply([...picked], rowBrush)}
          className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40"
        >
          {t('applyRow', { count: picked.size })}
        </button>
      </div>
    </div>
  );
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
 * reaches a server action. The rows are prepared on the SERVER (app/roster/page.tsx) and carry only the
 * dates that are actually rostered — never the grey ghosts, which have no stored row and must not be
 * hardened into one by a round trip.
 */
export function RosterTemplateButton({
  header,
  rows,
  month,
  codes,
  label,
  notesTitle,
  notes,
  failedLabel,
}: {
  header: string[];
  rows: string[][];
  month: string;
  codes: string[];
  label: string;
  notesTitle: string;
  notes: string[];
  failedLabel: string;
}) {
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
