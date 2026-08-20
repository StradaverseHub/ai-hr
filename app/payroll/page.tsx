import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { listBatches } from '@/core/payroll';
import { listBatchProcessedDates } from '@/core/payroll-view';
import { listCompanies } from '@/core/read';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { deleteDraftBatchAction } from './actions';
import { resumeHref } from './process/selection-logic';
import { isModuleEnabledOrFalse, settingEnabledOrDefault } from '@/core/entitlements';
import { payrollPublicationState } from '@/lib/payroll-publication';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { formatMoney } from '@/lib/money';
import { payrollRunTypeEnum, payrollStatusEnum } from '@/db/schema';
import { DashboardFilterBar } from './dashboard-filters';
import { PayrollRowActions } from './row-actions';
import {
  MONTHS,
  applyFilters,
  asArray,
  dashboardHref,
  monthCells,
  parseMonths,
  parseYear,
  periodsForYear,
  selectedPeriods,
  summarise,
  yearOptions,
  type DashboardFilters,
} from './dashboard-logic';

/**
 * 7f6ca478 — the Payroll Process dashboard: a year selector, a twelve-month timeline you tick months
 * on, company / cycle / status filters, summary counts, and a full-width run table that refreshes on
 * every change with no Search button.
 *
 * THREE OF THE FIVE STATUSES IN THE REQUEST DO NOT EXIST, AND ARE NOT INVENTED HERE. The request asked
 * for Completed, Draft, Processing, Failed and Cancelled. `payrollStatusEnum` is exactly
 * ('draft','processed','closed'). There is no Processing state because generating a run is not a
 * background job you watch — `generatePayslips` is synchronous and transactional. For the same reason
 * there is no Failed state: a run that throws leaves NOTHING persisted, so there is no row to list, and
 * pre-process blockers stop a run before it starts. Cancelled is not a state either — a draft run is
 * deleted. Adding enum values to satisfy a mock would be a kernel change with a migration and a write
 * path, and the screen would then be showing states nothing can ever produce. It renders the three real
 * ones. See the plan's disclosure: a genuine Failed record is a change to how processing records itself.
 *
 * WHAT EACH COLUMN ACTUALLY IS, because three of them were assumed rather than checked:
 *  · Payment Date is `payroll_batch.batch_date` — a REAL stored column, and for any run created through
 *    the Payroll Process wizard it is the date the administrator chose (defaultPaymentDate only seeds
 *    the input). The plan's build note called it derived-and-not-stored; that was wrong, and rendering a
 *    freshly-derived date here would have overwritten the admin's choice on screen. Runs predating the
 *    wizard carry the '<period>-28' default, which the existing tooltip discloses.
 *  · Employees is `payroll_batch.employee_count`, stamped as `emps.length` at the moment payslips are
 *    written and zeroed by a reset — i.e. it IS the payslip count, not a drifting counter.
 *  · Processed Date comes from the `payroll-batch.processed` domain event (listBatchProcessedDates);
 *    there is no processed_at column. "Processed By" is deliberately absent — see that function.
 *
 * OUT OF SCOPE, DELIBERATELY: saved filter preferences and per-administrator column customisation. Both
 * are per-user persisted state — a new store and a new write path — not layout, and both were disclosed
 * as separate requests in the plan rather than silently dropped. The address bar is the shareable view.
 */

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  processed: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  closed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
};

/** Header cells never wrap: "Payroll Period", not "Payroll" over "Period" (the request's §5). */
const TH = 'whitespace-nowrap px-3 py-2 font-medium';

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    year?: string;
    m?: string | string[];
    company?: string | string[];
    cycle?: string | string[];
    status?: string | string[];
    page?: string;
    size?: string;
  }>;
}) {
  // ADR-0077 slice 4 — a courtesy redirect when the tenant has not bought this module, so they get
  // an explanation instead of the service error. NOT the control: the reads below refuse on their
  // own (D3), and this guard fails open on an unresolved snapshot. Applied at the module ENTRY
  // point; a deep link skips it and meets the service refusal, which is the correct outcome.
  await requireModule('payroll');
  const { s, scopeIds } = await scopedAdmin();
  const locale = await getLocale();
  const t = await getTranslations('payroll.list');
  // Payroll Reset (a03b2d9b) shares the batch-detail namespace so the confirm copy is written once.
  const tb = await getTranslations('payroll.batch');
  const resetOn = settingEnabledOrDefault(s, 'payroll.reset_enabled');
  // e440991b — the Reprocess row action. Gated exactly as the run screen gates the way in, so the list
  // never offers a door the destination will refuse. This screen did not read the flag before: it had
  // no reprocess action at all, which was the whole complaint.
  const multiCycleOn = isModuleEnabledOrFalse(s, 'multi_cycle_payroll');
  const sp = await searchParams;
  const { error } = sp;

  // "This year" MUST come through the tenant clock. `new Date().getFullYear()` is the PREVIOUS year
  // between 00:00 and 08:00 MYT on 1 January, and on a screen whose whole organising axis is the year
  // that means opening on the wrong one — with an empty timeline — for eight hours every New Year.
  const thisYear = Number(todayInKualaLumpur().slice(0, 4));
  const filters: DashboardFilters = {
    year: parseYear(sp.year, thisYear),
    months: parseMonths(sp.m),
    companyIds: asArray(sp.company),
    cycles: asArray(sp.cycle),
    statuses: asArray(sp.status),
  };

  // 9066bd6c — THE SELECTION THE OPERATOR IS LOOKING AT, carried onto every row link as `?from=…`.
  //
  // The filters have lived in the address bar since 7f6ca478 (dashboard-logic.ts: "every control writes
  // the address bar"), so nothing about the FILTERING was broken. What lost them was leaving this screen:
  // the row link went to a bare `/payroll/<id>` and the destination's Back went to a bare `/payroll`, so
  // returning meant re-picking the year, months, company, cycle and status every time. `dashboardHref`
  // is the one place that serialises a selection, and this reuses it rather than rebuilding the query.
  // Encoded once here; re-validated BY SHAPE at the other end (lib/return-to.ts), never echoed raw.
  const fromQuery = encodeURIComponent(dashboardHref(filters));

  const [yearBatches, allBatches, companies] = await Promise.all([
    // The GRID + TIMELINE read: exactly the twelve periods of the selected year, pushed into SQL through
    // listBatches' widened period-set argument. Bounded by construction, and it is the whole year rather
    // than only the ticked months on purpose — every month cell shows its own run count, so an untick
    // must not blind the timeline to what is in the months you are not looking at.
    listBatches(s, scopeIds, periodsForYear(filters.year)),
    // The UNPUBLISHED BANNER read, and NOTHING else. ef31d251 exists because eighteen runs were
    // processed and never closed, so no employee ever saw a payslip — "a skipped one cannot sit
    // unnoticed for months". That warning has to span ALL TIME: counted off the year's rows instead, a
    // run left unpublished last December would stop being warned about the moment the clock ticked over
    // to January, which is precisely the failure it was written to prevent. If this read ever becomes
    // expensive the fix is to make it a COUNT — not to scope it to the selected year.
    listBatches(s, scopeIds),
    // Company filter options. Sourced from the authorised company list rather than from the year's runs,
    // so the dropdown does not change shape as you step through years and a selected company cannot
    // vanish underneath you. Narrowed to scopeIds: a view filter must never widen the access fence.
    listCompanies(s),
  ]);

  // TWO passes, and the split is what makes the timeline honest. The counts on the month cells are
  // taken AFTER company / cycle / status but BEFORE the month selection: after, so ticking a company
  // shows you which months that company actually ran in (a badge of 2 that yields an empty table when
  // you click it is worse than no badge); before, so unticking a month does not blank out the very
  // counts you use to choose the next one.
  const scopeMatched = applyFilters(yearBatches, {
    periods: periodsForYear(filters.year),
    companyIds: filters.companyIds,
    cycles: filters.cycles,
    statuses: filters.statuses,
  });
  const rows = applyFilters(scopeMatched, {
    periods: selectedPeriods(filters.year, filters.months),
    companyIds: [],
    cycles: [],
    statuses: [],
  });
  const summary = summarise(rows);

  // fc776376 — payroll runs accumulate every period, so the list pages like every other list.
  const { rows: batchPage, state: pgState } = paginateRows(rows, parsePageQuery(sp));
  // Only the VISIBLE page's runs are dated: the event read is keyed on the batch ids actually rendered,
  // so it costs one small indexed query no matter how many runs the year holds.
  const processedOn = await listBatchProcessedDates(s, batchPage.map((b) => b.id));

  const unpublishedCount = allBatches.filter((b) => payrollPublicationState(b) === 'unpublished').length;

  // Month names are CALENDAR DATA, not product copy — Intl already knows them in every locale this app
  // ships, so putting twelve more strings × six catalogs into the message files would be inventing a
  // maintenance burden to restate what the platform gets right. Formatted UTC against a synthetic date:
  // the value is a month name, so there is no instant to drift.
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const monthLabels = MONTHS.map((m) => monthFmt.format(new Date(Date.UTC(2000, m - 1, 1))));
  const dateFmt = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  // A date-only column ('YYYY-MM-DD') is parsed as UTC and formatted as UTC — matched ends, so the day
  // printed is the day stored. Parsing it in local time is the classic off-by-one.
  const showDate = (iso: string | null | undefined) =>
    iso ? dateFmt.format(new Date(`${iso}T00:00:00Z`)) : '—';

  const scopedCompanies = companies
    .filter((c) => scopeIds.includes(c.id))
    .map((c) => ({ id: c.id, name: c.name }));

  const summaryTiles = [
    { key: 'total', label: t('summaryTotal'), value: summary.total, tone: 'text-foreground' },
    { key: 'draft', label: t('status.draft'), value: summary.draft, tone: 'text-muted-foreground' },
    { key: 'processed', label: t('status.processed'), value: summary.processed, tone: 'text-blue-600 dark:text-blue-400' },
    { key: 'closed', label: t('status.closed'), value: summary.closed, tone: 'text-emerald-600 dark:text-emerald-400' },
  ];

  return (
    <div className={pageWideCls}>
      <div data-tour="payroll-intro">
        <PageHeader
          title={t('title')}
          actions={
            /* Feedback 8bf6dfa1: "Import payroll history" moved off this operational header into the
               Payroll > Transactions hub (admin data-maintenance grouping). Route unchanged. */
            <Button asChild data-tour="payroll-create">
              <Link href="/payroll/process">{t('newRun')}</Link>
            </Button>
          }
        />
      </div>

      <ErrorBanner message={error} />

      <DashboardFilterBar
        filters={filters}
        yearOptions={yearOptions(filters.year, thisYear)}
        // Each cell's count is put into words HERE, on the server. Passing `(n) => t(…)` instead is a
        // closure across the server/client boundary, which React cannot serialise: it returns 500 on
        // every request while tsc, the suite and next build all stay green (r123 / b55fdf33).
        cells={monthCells(monthLabels, filters.months, scopeMatched).map((c) => ({
          ...c,
          runsLabel: t('runsInMonth', { n: c.runs }),
        }))}
        companies={scopedCompanies}
        // The cycle options are the run-type enum itself, labelled from payroll.list.runType — the ONE
        // namespace that actually holds those four keys (r134 shipped a screen reading them from a
        // namespace that never had them, and every run page said MISSING_MESSAGE).
        cycleOptions={payrollRunTypeEnum.enumValues.map((v) => ({ value: v, label: t(`runType.${v}`) }))}
        statusOptions={payrollStatusEnum.enumValues.map((v) => ({ value: v, label: t(`status.${v}`) }))}
        labels={{
          year: t('filterYear'),
          previousYear: t('previousYear'),
          nextYear: t('nextYear'),
          months: t('filterMonths'),
          allMonths: t('allMonths'),
          company: t('colCompany'),
          allCompanies: t('allCompanies'),
          companySearch: t('companySearch'),
          selectAll: t('selectAll'),
          clearAll: t('clearAll'),
          // Indexed by n, 0 … however many companies can be ticked — a pre-rendered array rather than a
          // formatter, for the same serialisation reason as `runsLabel` above.
          selectedCountLabels: Array.from({ length: scopedCompanies.length + 1 }, (_, n) =>
            t('selectedCount', { n }),
          ),
          cycle: t('colCycle'),
          allCycles: t('allCycles'),
          status: t('colStatus'),
          allStatuses: t('allStatuses'),
          clearFilters: t('clearFilters'),
        }}
      />

      {unpublishedCount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          🙈 {t('notPublishedBanner', { n: unpublishedCount })}
        </div>
      )}

      {/* Summary counts for the three states that exist. Deliberately no "Processing" or "Failed" tile:
          a permanent, authoritative "Failed: 0" would be a reassurance this system is in no position to
          give, because a failed run leaves nothing behind to count. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {summaryTiles.map((tile) => (
          <div key={tile.key} className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-xs font-medium text-muted-foreground">{tile.label}</div>
            <div className={`mt-0.5 text-2xl font-semibold tabular-nums ${tile.tone}`}>{tile.value}</div>
          </div>
        ))}
      </div>

      <Card className="overflow-hidden" data-tour="payroll-batches">
        <SectionHeader title={t('batches')} count={rows.length} />
        {/* Full-width table; horizontal scroll lives on this wrapper so a narrow viewport scrolls the
            GRID rather than the page, and no column has to wrap to fit. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[64rem] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className={TH}>{t('colPeriod')}</th>
                <th className={TH}>{t('colCycle')}</th>
                <th className={TH}>{t('colCompany')}</th>
                <th className={TH}>{t('colPaymentDate')}</th>
                <th className={`${TH} text-right`}>{t('colEmployees')}</th>
                <th className={`${TH} text-right`}>{t('colNetPay')}</th>
                <th className={TH}>{t('colStatus')}</th>
                <th className={TH}>{t('colProcessedDate')}</th>
                <th className={`${TH} text-right`}>{t('colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {batchPage.map((b) => {
                const totals = b.totals as { net?: number } | null;
                return (
                  <tr key={b.id} className="hover:bg-muted/40">
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {/* A DRAFT batch resumes into the wizard at Step 1 (Payroll Period & Company shown
                          read-only for review — feedback 4f00d8f0), then Employee Selection. Processed/closed
                          batches open directly as read-only, unchanged. */}
                      <Link href={resumeHref(b.id, b.status)} className="font-medium hover:text-primary">
                        {b.payPeriod}
                      </Link>
                    </td>
                    {/* Payroll Cycle: same pattern as the batch detail page — the runType label, plus the
                        free-text remarks (e.g. Advance Salary / Mid-Month) when present, so wizard cycles
                        stored under the generic 'off_cycle' bucket display distinctly. */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                      {t(`runType.${b.runType}`)}
                      {b.remarks ? ` — ${b.remarks}` : ''}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{b.company}</td>
                    <td
                      className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground"
                      title={b.batchDate?.endsWith('-28') ? t('paymentDateLegacyNote') : undefined}
                    >
                      {showDate(b.batchDate)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{b.employeeCount}</td>
                    {/* Money goes through lib/money.formatMoney with the COMPANY's own currency — this
                        list spans every company in scope, which is exactly where a hard-coded "RM" makes
                        a false statement about somebody's pay. */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                      {totals?.net != null ? formatMoney(totals.net, b.currency) : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[b.status]}`}
                      >
                        {t(`status.${b.status}`)}
                      </span>
                      {/* ef31d251 — a second badge, from the SHARED derivation rather than a repeated
                          inline `b.status === 'processed'` test, so this and the run detail header can
                          never drift apart about what has actually reached employees. */}
                      {payrollPublicationState(b) === 'unpublished' && (
                        <span className="ml-1.5 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                          {t('notPublishedBadge')}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground">
                      {showDate(processedOn.get(b.id))}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link
                          href={`/payroll/${b.id}?from=${fromQuery}`}
                          className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
                        >
                          {t('rowView')}
                        </Link>
                        {b.status === 'draft' && (
                          <Link
                            href={resumeHref(b.id, b.status)}
                            className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
                          >
                            {t('rowContinue')}
                          </Link>
                        )}
                        {/* Delete is available for DRAFT runs ONLY (feedback 4f00d8f0) — processed/closed rows
                            render nothing here. ConfirmSubmit gates the destructive submit behind the reporter's
                            confirmation copy; the draft-only guard is re-enforced server-side (deleteDraftBatch
                            throws BatchNotDraftError for anything else). */}
                        {b.status === 'draft' && (
                          <form action={deleteDraftBatchAction}>
                            <input type="hidden" name="batchId" value={b.id} />
                            <ConfirmSubmit
                              size="sm"
                              title={t('deleteDraftTitle')}
                              description={t('deleteDraftBody')}
                              confirmLabel={t('deleteDraft')}
                            >
                              {t('deleteDraft')}
                            </ConfirmSubmit>
                          </form>
                        )}
                        {/* 65e2d5de — THE OTHER THREE ACTIONS MOVE BEHIND A ⋯ MENU, and nothing else about
                            them changes. Each is written here, under its own unchanged condition, and
                            handed to the island as an already-rendered node; the island only decides
                            WHERE it sits (and renders a lone survivor inline rather than a menu of one).
                            The reporter's complaint was the width four side-by-side controls forced on
                            the grid, not the actions themselves — see app/payroll/row-actions.tsx. */}
                        <PayrollRowActions moreLabel={t('rowMoreActions')}>
                          {/* e440991b — REPROCESS, from the list. Correcting one person on a processed run
                              used to mean opening the run, scrolling past the payslips and past the
                              Recalculation History, and finding tick-boxes at the bottom of a 1,286-line
                              page; this screen offered no way in at all. PROCESSED rows only (a draft has
                              no payslips; a closed run is immutable) and only with multi-cycle on — the
                              same gates the destination re-asserts and the service enforces. Placed
                              between View and Reset because Reset is the different, whole-run action. */}
                          {b.status === 'processed' && multiCycleOn && (
                            <Link
                              href={`/payroll/${b.id}/reprocess?from=${fromQuery}`}
                              className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
                            >
                              {tb('reprocessAction')}
                            </Link>
                          )}
                          {/* 9066bd6c — REMOVE EMPLOYEE PAYROLL, between Reprocess and Reset because that
                              is the order of escalation: correct one person, take one person off, clear
                              the whole run. PROCESSED rows only, multi-cycle on (the Reprocess screen is
                              the way back, and removal must never be offered where re-adding is
                              impossible) and the same `payroll.reset_enabled` risk switch Reset rides —
                              all three re-asserted by the destination and by the service. */}
                          {b.status === 'processed' && multiCycleOn && resetOn && (
                            <Link
                              href={`/payroll/${b.id}/remove?from=${fromQuery}`}
                              className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
                            >
                              {tb('removeAction')}
                            </Link>
                          )}
                          {/* Reset / Zeroize (feedback a03b2d9b): PROCESSED rows only — a processed run is
                              locked; the controlled reset returns it to Draft (payslips cleared, loan/claim
                              side-effects reversed, audited). Closed rows render nothing: permanently
                              immutable. Admin-only + processed-only re-enforced server-side. This is the
                              "Rollback (subject to permissions)" action the request listed.

                              9f8cd608 — IT IS A LINK NOW, exactly like Reprocess and Remove Employee above,
                              and the condition on it is untouched. It used to be a `<form>` carrying a
                              ConfirmSubmit dialog rendered inside the menu; the menu is a `position: fixed`
                              panel that closes on any scroll, the dialog was OWNED by that subtree, and
                              pressing the button scrolled the table wrapper to focus it — so the dialog was
                              created and destroyed in the same tick and the operator saw nothing happen.
                              The confirmation, the reason field and the run's own identity now live on
                              app/payroll/[batchId]/reset, which also carries the filter selection through as
                              `from` so a successful reset still lands on this list as it was left. */}
                          {b.status === 'processed' && resetOn && (
                            <Link
                              href={`/payroll/${b.id}/reset?from=${fromQuery}`}
                              className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
                            >
                              {tb('resetPayroll')}
                            </Link>
                          )}
                        </PayrollRowActions>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {batchPage.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                    {/* `year` is passed as a STRING: ICU formats a number argument with grouping, and
                        "2,026" is not a year. */}
                    {allBatches.length === 0 ? t('empty') : t('filteredEmpty', { year: String(filters.year) })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {/* Paging must carry the whole filter state, so page 2 of a four-month selection is still that
            selection. hrefFor (rather than `params`) because the address holds REPEATED params. */}
        <Pager
          hrefFor={(over) => {
            const base = dashboardHref(filters);
            const extra = new URLSearchParams();
            if (over.page) extra.set('page', String(over.page));
            if (over.size ?? pgState.size) extra.set('size', String(over.size ?? pgState.size));
            const qs = extra.toString();
            return qs ? `${base}&${qs}` : base;
          }}
          state={pgState}
        />
      </Card>
    </div>
  );
}
