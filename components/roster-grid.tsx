'use client';

/**
 * Roster scheduling grid (ADR-0032 C3). Pick a "brush" (a shift / Rest / Clear) from the palette, then
 * click cells to assign. Each click calls a server action and optimistically updates; a bulk bar applies
 * the brush to every selected employee across the visible week. A §59 (one rest day per week) warning
 * flags any employee with a shift on all 7 visible days.
 */
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { assignCellAction, bulkAssignAction } from '@/app/roster/actions';
import { EmployeeName } from '@/components/ui';

type ShiftLite = { id: string; name: string; startTime: string; endTime: string };
type CellState = { kind: 'shift'; shiftId: string } | { kind: 'rest' } | null;
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

export function RosterGrid({
  weekDates,
  employees,
  shifts,
  initial,
}: {
  weekDates: { iso: string; dow: string; day: string }[];
  employees: { employmentId: string; name: string; code?: string | null }[];
  shifts: ShiftLite[];
  initial: Record<string, CellState>;
}) {
  const t = useTranslations('roster');
  const [cells, setCells] = useState<Record<string, CellState>>(initial);
  const [brush, setBrush] = useState<Brush>(shifts[0]?.id ?? 'rest');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [, startTx] = useTransition();

  const shiftIndex = (id: string) => shifts.findIndex((s) => s.id === id);
  const shiftColor = (id: string) => SHIFT_COLORS[Math.max(0, shiftIndex(id)) % SHIFT_COLORS.length];
  const shiftName = (id: string) => shifts.find((s) => s.id === id)?.name ?? '?';
  const cellFromBrush = (br: Brush): CellState =>
    br === 'rest' ? { kind: 'rest' } : br === 'clear' ? null : { kind: 'shift', shiftId: br };

  const paint = (employmentId: string, iso: string) => {
    const key = `${employmentId}|${iso}`;
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
    const dates = weekDates.map((d) => d.iso);
    setCells((c) => {
      const n = { ...c };
      for (const e of empIds) for (const d of dates) n[`${e}|${d}`] = cellFromBrush(brush);
      return n;
    });
    startTx(async () => {
      const r = await bulkAssignAction({ employmentIds: empIds, shiftDates: dates, brush });
      if (!r.ok) toast.error(r.error);
      else toast.success(t('bulkDone', { n: empIds.length }));
    });
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = employees.length > 0 && selected.size === employees.length;

  // §59: warn when every visible day carries a shift (no rest day in the week).
  const noRestDay = (employmentId: string) =>
    weekDates.every((d) => cells[`${employmentId}|${d.iso}`]?.kind === 'shift');

  const brushChip = (value: Brush, label: string, cls: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setBrush(value)}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${cls} ${
        brush === value ? 'ring-2 ring-offset-1 ring-foreground/40' : 'opacity-80 hover:opacity-100'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      {/* Palette */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('brush')}</span>
        {shifts.map((s) => brushChip(s.id, `${s.name} · ${hhmm(s.startTime)}–${hhmm(s.endTime)}`, shiftColor(s.id)))}
        {brushChip('rest', t('restDay'), 'bg-muted text-muted-foreground')}
        {brushChip('clear', t('clear'), 'bg-background text-muted-foreground')}
      </div>

      {/* Bulk bar */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{t('selectedCount', { n: selected.size })}</span>
        <button
          type="button"
          onClick={applyBulk}
          disabled={selected.size === 0}
          className="rounded-md border border-border px-2 py-1 font-medium text-foreground enabled:hover:bg-muted disabled:opacity-40"
        >
          {t('applyToWeek')}
        </button>
      </div>

      {/* Grid */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-muted/50">
              <th className="sticky left-0 z-10 bg-muted/50 px-3 py-2 text-left font-medium">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(employees.map((e) => e.employmentId)))}
                  />
                  {t('employee')}
                </label>
              </th>
              {weekDates.map((d) => (
                <th key={d.iso} className="px-2 py-2 text-center font-medium">
                  <div>{d.dow}</div>
                  <div className="text-[11px] font-normal text-muted-foreground">{d.day}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {employees.map((e) => (
              <tr key={e.employmentId}>
                <td className="sticky left-0 z-10 bg-background px-3 py-1.5">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.has(e.employmentId)} onChange={() => toggle(e.employmentId)} />
                    <EmployeeName code={e.code} name={e.name} className="truncate" />{/* ID left-of-name (38668d9b) */}
                    {noRestDay(e.employmentId) && (
                      <span
                        title={t('noRestWarningHint')}
                        className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-400"
                      >
                        {t('noRest')}
                      </span>
                    )}
                  </label>
                </td>
                {weekDates.map((d) => {
                  const cell = cells[`${e.employmentId}|${d.iso}`] ?? null;
                  return (
                    <td key={d.iso} className="p-1 text-center">
                      <button
                        type="button"
                        onClick={() => paint(e.employmentId, d.iso)}
                        className={`min-h-[28px] w-full rounded px-1 py-1 text-[11px] font-medium transition hover:ring-1 hover:ring-foreground/30 ${
                          cell?.kind === 'shift'
                            ? shiftColor(cell.shiftId)
                            : cell?.kind === 'rest'
                              ? 'bg-muted text-muted-foreground'
                              : 'text-muted-foreground/40 hover:bg-muted/50'
                        }`}
                      >
                        {cell?.kind === 'shift' ? shiftName(cell.shiftId) : cell?.kind === 'rest' ? t('rest') : '—'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
