'use client';

import { Fragment, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { SUBJECT_COLUMNS, filterGridRows, type GridRowGroup, type HistoryGridRow } from './history-pivot';

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
 * FROZEN COLUMNS. Code / Description / Pay cycle / Company are sticky from `md:` up, so scrolling across
 * the months keeps the row identifiable. Below `md:` they scroll with everything else on purpose — four
 * frozen columns on a phone leave no room for a month. The horizontal scroll lives in this component's OWN
 * container so the page body never scrolls sideways.
 *
 * 3c88d593 — THE COMPANY COLUMN, and why it is inside the frozen block. A row is one EMPLOYER'S line since
 * r206: an employee who transferred entity mid-month has two August lines per pay item, and the only thing
 * telling them apart is this column. Scrolling it out of view while reading across the months is exactly
 * the confusion the column was added to remove, so it freezes with the identity columns rather than with
 * the figures. It costs the block 11rem, which is why the note above now says four.
 */

/**
 * The four frozen columns, declared once: a sticky offset that disagrees with the width in front of it
 * makes columns overlap while scrolling, and that is only visible on a wide screen mid-scroll. `company`
 * is the last of the block and carries the rule that marks where the freeze ends.
 */
const COL = {
  code: { th: 'w-[7rem] min-w-[7rem]', left: 'md:left-0' },
  name: { th: 'w-[14rem] min-w-[14rem]', left: 'md:left-[7rem]' },
  cycle: { th: 'w-[8rem] min-w-[8rem]', left: 'md:left-[21rem]' },
  company: { th: 'w-[11rem] min-w-[11rem]', left: 'md:left-[29rem] md:border-e md:border-border' },
};

/** How many columns the frozen block holds — the section headings span exactly it. */
const FROZEN_COLS = 4;

/** Section order + heading key, matching the pivot's own group ordering. */
const GROUPS: { group: GridRowGroup; key: string }[] = [
  { group: 'earning', key: 'earnings' },
  { group: 'deduction', key: 'deductions' },
  { group: 'employer', key: 'employer' },
  { group: 'item', key: 'items' },
  { group: 'summary', key: 'summary' },
  // 0253dc7c — the wage bases come LAST: after the earnings, deductions and roll-ups an operator reads
  // first, the wage base block sits at the bottom of the Transaction Detail table as the reference for
  // checking the figures above it.
  { group: 'wagebase', key: 'wagebase' },
];


/**
 * Amount tint. The pair is the codebase's existing positive/negative vocabulary (the dashboard and
 * attendance screens use exactly these two classes), not a second palette invented for this screen — and it
 * is what the reporter's reference does with earnings and deductions.
 */
const GROUP_TINT: Record<GridRowGroup, string> = {
  // 0253dc7c — a wage base is not money that moved, so it takes neither the earning nor the deduction
  // tint. Giving it one would invite an operator to read it as a payment or a deduction.
  wagebase: 'text-foreground',
  earning: 'text-emerald-600 dark:text-emerald-400',
  deduction: 'text-rose-600 dark:text-rose-400',
  employer: 'text-muted-foreground',
  item: 'text-muted-foreground',
  // Colour only — weight is set on the ROW (below). Two competing font-weight utilities on one cell
  // resolve by stylesheet order, not by which one you meant.
  summary: 'text-foreground',
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
  basesNotRecorded,
  subjectFromCatalogue,
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
  /** 0253dc7c — at least one run predates the wage-base stamp, so part of that block is em dashes. */
  basesNotRecorded: boolean;
  /** 0253dc7c — at least one Y/N on screen is today's Pay Item setting, not the run's own record. */
  subjectFromCatalogue: boolean;
}) {
  const t = useTranslations('payroll.transactions');
  // The reference has both ticked. Ours differs on the second, deliberately: our "system" rows carry the
  // statutory lines and the aggregates, and a run with no stored per-item detail would render as an empty
  // grid if they were hidden by default. So hiding them is opt-in.
  const [hideZero, setHideZero] = useState(true);
  const [hideSystem, setHideSystem] = useState(false);
  // 0253dc7c — five extra columns is a lot of width for a question an operator asks occasionally, so
  // this is off by default and the grid looks exactly as it does today until it is turned on.
  const [showSubject, setShowSubject] = useState(false);

  const shown = useMemo(() => filterGridRows(rows, { hideZero, hideSystem }), [rows, hideZero, hideSystem]);

  const exportHref = `/payroll/transaction-view/grid-export?${new URLSearchParams({
    ...exportParams,
    hideZero: hideZero ? '1' : '0',
    hideSystem: hideSystem ? '1' : '0',
    // The switch rides the link so the file matches the screen it was taken from — the route applies
    // the SAME `filterGridRows` and projects the same columns. Rebuilding either in the route is how
    // the file and the screen drift apart.
    showSubject: showSubject ? '1' : '0',
  }).toString()}`;

  const colCount = FROZEN_COLS + (showSubject ? SUBJECT_COLUMNS.length : 0) + months.length + 1;

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
          {/* 0253dc7c — the Y/N columns. A SEPARATE switch, deliberately not folded into
              "Hide system codes": that one is all-or-nothing by design and removing it would break
              the people who use it. */}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showSubject}
              onChange={(e) => setShowSubject(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            {t('view.grid.showSubject')}
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
      {/* 0253dc7c — the two honesty captions. Neither is decorative: without the first, an em dash in
          the wage-base block reads as a broken screen; without the second, a Y from today's catalogue
          sitting beside an older figure is exactly the confusion this item was raised about. */}
      {basesNotRecorded && <p className="text-xs text-muted-foreground">{t('view.grid.basesNotRecorded')}</p>}
      {showSubject && (
        <p className="text-xs text-muted-foreground">
          {subjectFromCatalogue ? t('view.grid.subjectFromCatalogue') : t('view.grid.subjectFromPayslip')}
        </p>
      )}

      {/* The scroll container. `overflow-x-auto` is on THIS div, never on the page, so the body never
          scrolls sideways however many months are selected. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
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
              {/* 3c88d593 — the employer that paid this line. */}
              <th className={`${COL.company.th} ${COL.company.left} sticky z-10 bg-muted px-3 py-2 font-medium`}>
                {t('view.grid.colCompany')}
              </th>
              {/* 0253dc7c — the subject columns sit immediately after the identity block, before the
                  months, so the setting reads next to the item it belongs to. They are NOT sticky:
                  the frozen block is FOUR columns wide by design (3c88d593 added Company to it) and
                  widening it further leaves a phone no room for a month. */}
              {showSubject &&
                SUBJECT_COLUMNS.map((c) => (
                  <th key={c.key} className="min-w-[4.5rem] px-3 py-2 text-center font-medium">
                    {t(`view.grid.subject.${c.key}`)}
                  </th>
                ))}
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
                  {/* The heading spans the FROZEN block and sticks with it, rather than being one
                      full-width colSpan cell: scroll a full-width heading away and the operator loses
                      which section they are reading, which is when a deduction gets read as an earning. */}
                  <tr className="bg-muted/40">
                    <td
                      colSpan={FROZEN_COLS}
                      className="sticky z-10 whitespace-nowrap bg-muted px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:left-0 md:border-e md:border-border"
                    >
                      {t(`view.grid.section.${key}`)}
                    </td>
                    <td colSpan={colCount - FROZEN_COLS} className="px-3 py-1.5" />
                  </tr>
                  {groupRows.map((r) => (
                    <tr
                      key={r.key}
                      className={`transition-colors hover:bg-muted/30 ${
                        r.group === 'summary' ? 'font-semibold' : ''
                      }`}
                    >
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
                      {/* 3c88d593 — the employer, and underneath it the days that employer actually
                          covered when the month was split by an entity transfer. The dates come from the
                          payslip's OWN record, so they are the same words the payslip prints; an
                          unsegmented row carries no `segments` at all and renders the company name alone,
                          exactly as this cell would have if the column had always been here. */}
                      <td
                        className={`${COL.company.th} ${COL.company.left} sticky z-10 bg-card px-3 py-2 align-top`}
                      >
                        <span className="block truncate" title={r.company}>
                          {r.company}
                        </span>
                        {r.segments?.map((s) => (
                          <span key={`${s.from}:${s.to}`} className="mt-0.5 block text-[11px] text-muted-foreground">
                            {t('view.history.coverageLine', { from: s.from, to: s.to })}
                          </span>
                        ))}
                      </td>
                      {/* 0253dc7c — Y / N, or blank on a row that is not a pay item. Blank, never "N":
                          a row with no setting to report has not answered "no", and printing one would
                          be a wrong answer on the screen this whole item is about. */}
                      {showSubject &&
                        SUBJECT_COLUMNS.map((c) => (
                          <td key={c.key} className="px-3 py-2 text-center text-xs">
                            {r.subject ? (
                              <span className={r.subject[c.read] ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                                {r.subject[c.read] ? t('view.grid.subject.yes') : t('view.grid.subject.no')}
                              </span>
                            ) : (
                              ''
                            )}
                          </td>
                        ))}
                      {months.map((m) => {
                        const v = r.months[m - 1];
                        // 0253dc7c — this month's payslip carried no wage-base stamp, so the base is
                        // UNKNOWN. An em dash, never 0.00 and never a substituted figure.
                        const unrecorded = r.unrecordedMonths?.[m - 1] === true;
                        return (
                          <td
                            key={m}
                            className={`px-3 py-2 text-right tabular-nums ${
                              v === 0 || unrecorded ? 'text-muted-foreground/60' : GROUP_TINT[r.group]
                            }`}
                          >
                            {/* efece4ce — an unregistered company levies nothing, and a bare 0.00 made that
                                indistinguishable from a levy that failed to compute. The row says which. */}
                            {r.notRegistered || unrecorded ? '—' : amount(v)}
                          </td>
                        );
                      })}
                      <td
                        className={`bg-muted/30 px-3 py-2 text-right font-medium tabular-nums ${GROUP_TINT[r.group]}`}
                      >
                        {/* 0253dc7c — a total of nothing but unknowns is itself unknown. If SOME months
                            were recorded the total is their sum, which is what is visible on the row. */}
                        {r.notRegistered
                          ? t('view.grid.notRegistered')
                          : months.every((m) => r.unrecordedMonths?.[m - 1])
                            ? '—'
                            : amount(r.total)}
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
