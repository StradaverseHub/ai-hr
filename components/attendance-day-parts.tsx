import type { ReactNode } from 'react';
import { AttendanceFigureCells, type AttendanceFigureCellsProps } from '@/components/attendance-figure-cells';

/**
 * r433 (faca1cfb round 1) — the presentational pieces of the attendance DAY screen
 * (app/attendance/individual/[date]/page.tsx), lifted into one file so the real-browser overflow test measures
 * the markup the screen ships rather than a copy of it. No logic lives here: every value arrives as a string
 * or number already read by the page, and every figure is rendered by the existing AttendanceFigureCells
 * island with the same working.
 */

/** One label over one value. `min-w-0` + `break-words` so a long name or company wraps inside its column. */
export function DayField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 break-words text-sm tabular-nums">{value}</div>
    </div>
  );
}

/** The grid the day screen's field sections share: two columns on a phone, four from `sm`. */
export function DayFieldGrid({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 }) {
  return (
    <div className={`grid gap-4 p-4 ${cols === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'}`}>{children}</div>
  );
}

export type DayOtItem = { only: NonNullable<AttendanceFigureCellsProps['only']>; label: string };

/** The Overtime rows: only the items handed in, one row each, the figure carrying its working on hover. */
export function DayOvertimeRows({
  items,
  figures,
  itemHeading,
  amountHeading,
  footnote,
}: {
  items: DayOtItem[];
  figures: Omit<AttendanceFigureCellsProps, 'only'>;
  itemHeading: string;
  amountHeading: string;
  footnote: string;
}) {
  return (
    <>
      <table data-day-ot-table className="w-full table-fixed text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{itemHeading}</th>
            <th className="px-3 py-2 text-right font-medium">{amountHeading}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((item) => (
            <tr key={item.only} data-day-ot-row={item.only}>
              <th scope="row" className="break-words px-3 py-2.5 text-left font-normal">
                {item.label}
              </th>
              <AttendanceFigureCells {...figures} only={item.only} />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-xs text-muted-foreground">{footnote}</p>
    </>
  );
}
