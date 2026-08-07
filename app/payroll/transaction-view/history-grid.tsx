'use client';

import { Fragment, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { filterGridRows, type GridRowGroup, type HistoryGridRow } from './history-pivot';

/**
 * Feedback 080de5cf — the spreadsheet grid for Transaction View › History › Grid.
 *
 * ONE PERSON'S YEAR ON ONE SCREEN: pay item down the left, month across the top, annual total on the right,
 * exactly as the reporter's reference. It is a SIBLING of the payslip-by-payslip History table, not a
 * replacement — that view answers "show me the payslips" and some people use it that way.
 *
 * Everything on screen is computed by `pivotHistoryGrid` on the SERVER and arrives here as plain data. The
 * only work this component does is the two switches from the reference (hide all-zero rows, hide system
 * codes) and the layout, which is why flipping a switch is instant and costs no round-trip. EVERY PROP IS
 * PLAIN DATA — no callback, no closure: a function prop crossing from a server component to a client one
 * returns a 500 on every request while tsc, the suite and `next build` all stay green.
 *
 * THE SWITCHES RIDE ON THE EXPORT LINK. "Export exactly what is displayed on screen" is the reporter's
 * wording, so the href carries the switch state and the route applies the SAME `filterGridRows` to the same
 * pivot. Rebuilding the filter in the route is how the file and the screen would drift apart.
 *
 * FROZEN COLUMNS. Code / Description / Pay cycle are sticky from `md:` up, so scrolling across the months
 * keeps the row identifiable. Below `md:` they scroll with everything else on purpose — three frozen
 * columns on a phone leave no room for a month. The horizontal scroll lives in this component's OWN
 * container so the page body never scrolls sideways.
 */

/** Sticky offsets must match these widths exactly, so the three frozen columns are declared once. */
const COL = {
  code: { th: 'w-[7rem] min-w-[7rem]', left: 'md:left-0' },
  name: { th: 'w-[14rem] min-w-[14rem]', left: 'md:left-[7rem]' },
  cycle: { th: 'w-[8rem] min-w-[8rem]', left: 'md:left-[21rem]' },
};

/** Section order + heading key, matching the pivot's own group ordering. */
const GROUPS: { group: GridRowGroup; key: string }[] = [
  { group: 'earning', key: 'earnings' },
  { group: 'deduction', key: 'deductions' },
  { group: 'employer', key: 'employer' },
  { group: 'item', key: 'items' },
  { group: 'summary', key: 'summary' },
];

/**
 * Amount tint. The pair is the codebase's existing positive/negative vocabulary (the dashboard and
 * attendance screens use exactly these two classes), not a second palette invented for this screen — and it
 * is what the reporter's reference does with earnings and deductions.
 */
const GROUP_TINT: Record<GridRowGroup, string> = {
  earning: 'text-emerald-600 dark:text-emerald-400',
  deduction: 'text-rose-600 dark:text-rose-400',
  employer: 'text-muted-foreground',
  item: 'text-muted-foreground',
  summary: 'font-semibold text-foreground',
};

const amount = (n: number) =>
  Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function HistoryGrid({
  rows,
  months,
  monthLabels,
  cycleLabels,
  exportParams,
  payslipCount,
  detailNotRecorded,
}: {
  /** The full pivot, unfiltered — the switches below narrow it in the browser. */
  rows: HistoryGridRow[];
  /** Month numbers (1-12) whose columns are shown, ascending. */
  months: number[];
  /** Twelve locale-formatted month names, index 0 = January. Resolved on the SERVER and passed as data:
   *  formatting them here would make the first client render disagree with the server's HTML for any locale
   *  whose ICU data differs between Node and the browser. */
  monthLabels: string[];
  /** Pre-translated run-type captions (`payroll.transactions.individual.cycle.*`), keyed by run type. A
   *  dynamic lookup resolved by the caller so this file stays single-namespace for the i18n key check. */
  cycleLabels: Record<string, string>;
  /** The already scope-guarded filter params to hand back to the export route. */
  exportParams: Record<string, string>;
  payslipCount: number;
  detailNotRecorded: boolean;
}) {
  const t = useTranslations('payroll.transactions');
  // The reference has both ticked. Ours differs on the second, deliberately: our "system" rows carry the
  // statutory lines and the aggregates, and a run with no stored per-item detail would render as an empty
  // grid if they were hidden by default. So hiding them is opt-in.
  const [hideZero, setHideZero] = useState(true);
  const [hideSystem, setHideSystem] = useState(false);

  const shown = useMemo(() => filterGridRows(rows, { hideZero, hideSystem }), [rows, hideZero, hideSystem]);

  const exportHref = `/payroll/transaction-view/grid-export?${new URLSearchParams({
    ...exportParams,
    hideZero: hideZero ? '1' : '0',
    hideSystem: hideSystem ? '1' : '0',
  }).toString()}`;

  const colCount = 3 + months.length + 1;

  return (
    <div className="space-y-3">
      {/* ── The two switches from the reference, plus the one Export button ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hideZero}
              onChange={(e) => setHideZero(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            {t('view.grid.hideZeroRows')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hideSystem}
              onChange={(e) => setHideSystem(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            {t('view.grid.hideSystemCodes')}
          </label>
        </div>
        <a
          href={exportHref}
          className="inline-flex shrink-0 items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t('view.grid.export')}
        </a>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('view.grid.summary', { payslips: payslipCount, rows: shown.length })}
      </p>
      {detailNotRecorded && <p className="text-xs text-muted-foreground">{t('view.grid.detailNotRecorded')}</p>}

      {/* The scroll container. `overflow-x-auto` is on THIS div, never on the page, so the body never
          scrolls sideways however many months are selected. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className={`${COL.code.th} ${COL.code.left} sticky z-10 bg-muted px-3 py-2 font-medium`}>
                {t('view.grid.colCode')}
              </th>
              <th className={`${COL.name.th} ${COL.name.left} sticky z-10 bg-muted px-3 py-2 font-medium`}>
                {t('view.grid.colDescription')}
              </th>
              <th className={`${COL.cycle.th} ${COL.cycle.left} sticky z-10 bg-muted px-3 py-2 font-medium`}>
                {t('view.grid.colCycle')}
              </th>
              {months.map((m) => (
                <th key={m} className="min-w-[6.5rem] px-3 py-2 text-right font-medium">
                  {monthLabels[m - 1]}
                </th>
              ))}
              <th className="min-w-[7.5rem] px-3 py-2 text-right font-medium">{t('view.grid.colTotal')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {GROUPS.map(({ group, key }) => {
              const groupRows = shown.filter((r) => r.group === group);
              if (groupRows.length === 0) return null;
              return (
                <Fragment key={group}>
                  <tr className="bg-muted/40">
                    <td
                      colSpan={colCount}
                      className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {t(`view.grid.section.${key}`)}
                    </td>
                  </tr>
                  {groupRows.map((r) => (
                    <tr key={r.key} className="transition-colors hover:bg-muted/30">
                      <td
                        className={`${COL.code.th} ${COL.code.left} sticky z-10 bg-card px-3 py-2 font-mono text-xs`}
                      >
                        {r.code}
                      </td>
                      <td className={`${COL.name.th} ${COL.name.left} sticky z-10 truncate bg-card px-3 py-2`}>
                        {/* A synthetic row's caption is a dynamic key under this same namespace; an item row
                            carries the name the payslip stored. */}
                        {r.labelKey ? r.name || t(`view.grid.row.${r.labelKey}`) : r.name}
                      </td>
                      <td
                        className={`${COL.cycle.th} ${COL.cycle.left} sticky z-10 bg-card px-3 py-2 text-muted-foreground`}
                      >
                        {cycleLabels[r.runType] ?? r.runType}
                      </td>
                      {months.map((m) => {
                        const v = r.months[m - 1];
                        return (
                          <td
                            key={m}
                            className={`px-3 py-2 text-right tabular-nums ${
                              v === 0 ? 'text-muted-foreground/60' : GROUP_TINT[r.group]
                            }`}
                          >
                            {/* efece4ce — an unregistered company levies nothing, and a bare 0.00 made that
                                indistinguishable from a levy that failed to compute. The row says which. */}
                            {r.notRegistered ? '—' : amount(v)}
                          </td>
                        );
                      })}
                      <td
                        className={`bg-muted/30 px-3 py-2 text-right font-medium tabular-nums ${GROUP_TINT[r.group]}`}
                      >
                        {r.notRegistered ? t('view.grid.notRegistered') : amount(r.total)}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-muted-foreground">
                  {t('view.grid.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
