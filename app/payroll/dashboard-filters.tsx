'use client';

/**
 * 7f6ca478 — the Payroll Process dashboard's filter bar: year stepper, twelve-month timeline, and the
 * company / cycle / status filters, all of which refresh the listing on change with NO Search button.
 *
 * PRE-TRANSLATED COPY ONLY. Every string arrives as a prop, exactly as components/filter-panel.tsx and
 * components/ui/multi-select-popover.tsx do. Two reasons, and the second is the one that has actually
 * bitten: the i18n coverage guard can only see LITERAL t('a.b') keys, so pushing lookups down into an
 * island hides them from it; and the payroll runType labels in particular are pinned by
 * test/payroll-run-type-label-namespace.test.ts, which walks app/payroll and resolves each call site's
 * namespace — a label resolved in components/ would fall outside that walk entirely (r134's
 * MISSING_MESSAGE on every run detail page is what that test exists for).
 *
 * EVERY CONTROL WRITES THE ADDRESS BAR, nothing is component state. That is what makes "no Search
 * button" honest rather than a trick: the URL is the whole filter state, so it is shareable, it survives
 * a refresh, and the server re-reads with the new period set instead of the page hiding rows it already
 * fetched. `useTransition` supplies the only thing an auto-refreshing list owes the reader — visible
 * evidence that the click did something while the server round-trips.
 */

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { inputCls } from '@/components/ui';
import { MultiSelectPopover } from '@/components/ui/multi-select-popover';
import {
  dashboardHref,
  toggleMonth,
  type DashboardFilters,
  type MonthCell,
} from './dashboard-logic';

/**
 * EVERY FIELD HERE IS A STRING, AND THAT IS THE CONTRACT, NOT A STYLE CHOICE.
 *
 * A server component cannot hand a client component a FUNCTION — React has to serialise the props across
 * the boundary and a closure has no serialisation. The first draft of this file took
 * `runsInMonth: (n) => string` and `selectedCount: (n) => string`, which is the natural shape when the
 * translator lives on the server; tsc was happy, the suite was happy, and every single request to
 * /payroll returned 500 ("Functions cannot be passed directly to Client Components"). That is the r123 /
 * b55fdf33 defect exactly, and the only thing that saw it was rendering the page on a dev server.
 *
 * So the counted strings arrive PRE-RENDERED: `runsLabel` is computed per month cell (the server already
 * knows each count), and `selectedCountLabels` is indexed by n. Any closure the popover needs is created
 * HERE, inside the island, where closures are legal.
 */
export type DashboardFilterLabels = {
  year: string;
  previousYear: string;
  nextYear: string;
  months: string;
  allMonths: string;
  company: string;
  allCompanies: string;
  companySearch: string;
  selectAll: string;
  clearAll: string;
  /** "{n} selected", pre-rendered and indexed by n (0 … number of companies). */
  selectedCountLabels: string[];
  cycle: string;
  allCycles: string;
  status: string;
  allStatuses: string;
  clearFilters: string;
};

/** A timeline cell with its run count already put into words by the server's translator. */
export type TimelineCell = MonthCell & { runsLabel: string };

export type SelectOption = { value: string; label: string };

const iconBtn =
  'grid size-9 shrink-0 place-items-center rounded-md border border-input bg-card text-muted-foreground transition duration-150 ease-snappy hover:bg-accent hover:text-foreground active:scale-95';

export function DashboardFilterBar({
  filters,
  yearOptions,
  cells,
  companies,
  cycleOptions,
  statusOptions,
  labels,
}: {
  filters: DashboardFilters;
  yearOptions: number[];
  cells: TimelineCell[];
  companies: { id: string; name: string }[];
  cycleOptions: SelectOption[];
  statusOptions: SelectOption[];
  labels: DashboardFilterLabels;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Created HERE, not passed in — see the note on DashboardFilterLabels.
  const selectedCount = (n: number) =>
    labels.selectedCountLabels[n] ?? labels.selectedCountLabels.at(-1) ?? String(n);

  const go = (next: DashboardFilters) =>
    startTransition(() => router.push(dashboardHref(next), { scroll: false }));

  const anyFilter =
    filters.months.length > 0 ||
    filters.companyIds.length > 0 ||
    filters.cycles.length > 0 ||
    filters.statuses.length > 0;

  return (
    <div
      // The <main> element is the app shell's scroll container, so `sticky top-0` here keeps the filters
      // in view while a long run list scrolls under them — the "sticky filter bar" the request asked for.
      className={cn(
        'sticky top-0 z-20 space-y-3 rounded-xl border border-border bg-card/95 p-3 backdrop-blur transition-opacity',
        pending && 'opacity-60',
      )}
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{labels.year}</span>
          <div className="flex items-center gap-1.5">
            {/* The arrows are NOT clamped to the dropdown's window: yearOptions always contains the
                selected year, so stepping past the edge extends the list rather than dead-ending. A
                tenant whose oldest run predates the window can still walk back to it. */}
            <button
              type="button"
              onClick={() => go({ ...filters, year: filters.year - 1 })}
              aria-label={labels.previousYear}
              className={iconBtn}
            >
              <ChevronLeft className="size-4" />
            </button>
            <select
              value={filters.year}
              onChange={(e) => go({ ...filters, year: Number(e.target.value) })}
              aria-label={labels.year}
              className={cn(inputCls, 'w-24 tabular-nums')}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => go({ ...filters, year: filters.year + 1 })}
              aria-label={labels.nextYear}
              className={iconBtn}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>

        <MultiSelectPopover
          label={labels.company}
          allLabel={labels.allCompanies}
          options={companies}
          selected={new Set(filters.companyIds)}
          onChange={(next) => go({ ...filters, companyIds: [...next] })}
          searchPlaceholder={labels.companySearch}
          selectAllLabel={labels.selectAll}
          clearAllLabel={labels.clearAll}
          selectedCount={selectedCount}
        />

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{labels.cycle}</span>
          <select
            value={filters.cycles[0] ?? ''}
            onChange={(e) => go({ ...filters, cycles: e.target.value ? [e.target.value] : [] })}
            className={cn(inputCls, 'w-44')}
          >
            <option value="">{labels.allCycles}</option>
            {cycleOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{labels.status}</span>
          <select
            value={filters.statuses[0] ?? ''}
            onChange={(e) => go({ ...filters, statuses: e.target.value ? [e.target.value] : [] })}
            className={cn(inputCls, 'w-40')}
          >
            <option value="">{labels.allStatuses}</option>
            {statusOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {anyFilter && (
          <button
            type="button"
            onClick={() => go({ year: filters.year, months: [], companyIds: [], cycles: [], statuses: [] })}
            className="h-9 rounded-md px-2 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {labels.clearFilters}
          </button>
        )}
      </div>

      {/* The twelve-month timeline. Each cell is a toggle, so one month, several consecutive months and
          several scattered months are all the same gesture. NO month ticked means the whole year — the
          screen opens showing everything rather than nothing, and the run count on each cell tells you
          where the data is before you click. */}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={labels.months}>
        <button
          type="button"
          onClick={() => go({ ...filters, months: [] })}
          aria-pressed={filters.months.length === 0}
          className={cn(
            'h-9 rounded-md border px-3 text-xs font-medium transition duration-150 ease-snappy active:scale-95',
            filters.months.length === 0
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {labels.allMonths}
        </button>
        {cells.map((c) => (
          <button
            key={c.month}
            type="button"
            onClick={() => go({ ...filters, months: toggleMonth(filters.months, c.month) })}
            aria-pressed={c.selected}
            title={c.runsLabel}
            className={cn(
              'flex h-9 min-w-[4.25rem] flex-1 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-medium transition duration-150 ease-snappy active:scale-95',
              c.selected
                ? 'border-primary bg-primary text-primary-foreground'
                : c.runs > 0
                  ? 'border-input bg-card text-foreground hover:bg-accent'
                  : 'border-dashed border-input bg-card text-muted-foreground/60 hover:bg-accent hover:text-foreground',
            )}
          >
            <span>{c.label}</span>
            {c.runs > 0 && (
              <span
                className={cn(
                  'grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-semibold tabular-nums',
                  c.selected ? 'bg-primary-foreground/25' : 'bg-muted text-muted-foreground',
                )}
              >
                <span aria-hidden>{c.runs}</span>
                <span className="sr-only">{c.runsLabel}</span>
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
