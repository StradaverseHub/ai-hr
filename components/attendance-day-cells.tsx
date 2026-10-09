import type { ReactNode } from 'react';
import { fmtMin } from '@/components/attendance-format';

/**
 * r432 (e721a355) — THE ONE PLACE the Individual and Daily Attendance lists draw a day.
 *
 * Both lists are the same ten columns: [two leading identity cells] Shift · Check In · Check Out · Shift Hrs
 * · Actual Hrs · Status · Flag · Action. Individual leads with Date + Day (one person across days); Daily
 * leads with Code + Name (everyone on one day). Everything from Shift to Flag, and the multi-clocking trail
 * line, used to be copy-pasted between the two pages — so a wording or colour change had to be made twice and
 * the pages could drift. They are drawn here now; each page keeps only its leading cells, its header row and
 * its Action cell.
 *
 * Presentational and server-safe on purpose: it takes pre-translated labels and an already-derived
 * status/flag, and imports nothing from the attendance pack. core/attendance-derive is a declared pack
 * boundary (test/attendance-pack-drift.test.ts); the page derives, this draws.
 */
export type DayStatus = 'present' | 'absent' | 'rest' | 'off' | 'ph' | 'on_leave';
export type DayFlag = 'late' | 'under' | 'odd';

export type DayCellLabels = {
  statusText: Record<DayStatus, string>;
  flagText: Record<DayFlag, string>;
  punchTrail: string;
  punchIn: string;
  punchOut: string;
  punchFirst: string;
  punchLast: string;
};

/** Builds the labels from the page's `t` (pre-translated: a translator closure must not cross into a client island). */
export function dayCellLabels(translate: (key: never) => string): DayCellLabels {
  const t = translate as unknown as (key: string) => string;
  return {
    statusText: {
      present: t('statusPresent'),
      absent: t('statusAbsent'),
      rest: t('statusRest'),
      off: t('statusOff'),
      ph: t('statusPh'),
      on_leave: t('statusOnLeave'),
    },
    flagText: { late: t('flagLate'), under: t('flagUnder'), odd: t('flagOdd') },
    punchTrail: t('punchTrail'),
    punchIn: t('punchIn'),
    punchOut: t('punchOut'),
    punchFirst: t('punchFirst'),
    punchLast: t('punchLast'),
  };
}

export type DayCellsRow = {
  shiftCode: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  scheduledMinutes: number | null;
  workedMinutes: number | null;
};

/** The seven cells from Shift to Flag. Only Absent is red; every other status uses the standard text colour. */
export function AttendanceDayCells({
  row,
  status,
  flag,
  labels,
}: {
  row: DayCellsRow;
  status: DayStatus;
  flag: DayFlag | null;
  labels: DayCellLabels;
}): ReactNode {
  return (
    <>
      <td className="px-3 py-2.5 text-muted-foreground">{row.shiftCode ?? '—'}</td>
      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{row.checkInAt?.slice(0, 5) ?? '—'}</td>
      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{row.checkOutAt?.slice(0, 5) ?? '—'}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMin(row.scheduledMinutes)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMin(row.workedMinutes)}</td>
      <td className="px-3 py-2.5" data-col="status">
        <span className={`capitalize ${status === 'absent' ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-foreground'}`}>
          {labels.statusText[status]}
        </span>
      </td>
      <td className="px-3 py-2.5" data-col="flag">
        {flag ? (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{labels.flagText[flag]}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </>
  );
}

/**
 * R45 — the punch trail under a multiple-clocking day (more than two punches). A single pair is already
 * fully shown by Check In / Check Out, so only a day with extras gets the line. Returns null otherwise.
 */
export function AttendanceTrailRow({
  punches,
  colSpan,
  labels,
}: {
  punches: readonly { punchAt: string; direction: 'in' | 'out' }[];
  colSpan: number;
  labels: DayCellLabels;
}): ReactNode {
  if (punches.length <= 2) return null;
  return (
    <tr className="bg-muted/20" data-row="trail">
      <td colSpan={colSpan} className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium uppercase tracking-wide">{labels.punchTrail}</span>
          {punches.map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 tabular-nums"
            >
              <span className="font-medium text-foreground">{p.punchAt.slice(0, 5)}</span>
              <span className={p.direction === 'in' ? 'text-emerald-600 dark:text-emerald-400' : 'text-indigo-600 dark:text-indigo-400'}>
                {p.direction === 'in' ? labels.punchIn : labels.punchOut}
              </span>
              {i === 0 && <span className="text-[10px] uppercase">· {labels.punchFirst}</span>}
              {i === punches.length - 1 && <span className="text-[10px] uppercase">· {labels.punchLast}</span>}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}
