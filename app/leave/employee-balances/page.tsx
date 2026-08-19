import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees, listLeaveTypes } from '@/core/read';
import { todayInKualaLumpur } from '@/core/leave';
import { Button, Card, PageHeader, inputCls } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { LeaveInquiryNav } from '@/components/leave/leave-inquiry-nav';
import { EmployeeSearchField } from '@/components/employee-search-field';
import { pickInquiryEmployee, sortInquiryEmployees } from '@/lib/leave-inquiry';
// 4a1abc4a: HR's copy of the employee's own balance grid must print the figures identically to it.
import { formatDays } from '@/lib/day-format';
// 31e39d74: HR's grid captions a 0.00 exactly as the employee's own grid does — one mapping, one wording.
import {
  ENTITLEMENT_STATUS_LABEL_KEY,
  ENTITLEMENT_STATUS_TIP_KEY,
  entitlementStatusNeedsNotice,
} from '@/lib/entitlement-status';
import { otherContributors } from '@/lib/shared-leave-balance';
import { employeeBalanceRows } from './rows';

/**
 * Employee Balances (feedback 20c699f8) — one employee's leave position across EVERY leave type they hold,
 * for an HR admin who is answering "where does this person stand".
 *
 * Every figure comes from the same two reads the employee's own Leave page uses (`leaveBalances` +
 * `leaveEntitlementBreakdown`) and is mapped by the same pure `deriveBalanceRow`. That is the point: a
 * second derivation here would eventually disagree with the employee's own screen, and the number HR
 * quotes would be the wrong one. The ONE deliberate difference is the ESS gate — `deriveBalanceRow`
 * blanks figures an HR admin has hidden from SELF-SERVICE, which is not a rule about what HR may see, so
 * the row is derived with an empty essView (missing key ⇒ visible).
 *
 * THE AS-AT DATE (3ddae357). This comment used to claim that changing the date re-ran the breakdown so
 * "YTD Entitled / Taken / Pending / Adjustment / Overutilized / Balance all move with it — no figure on
 * this screen is cached against another date". THAT WAS FALSE for four of them, and stating it is how the
 * defect survived review: `asOf` reached `leaveEntitlementBreakdown` but NOT `leaveBalances`, which had no
 * date argument at all, so Taken, Pending Approval, Overutilized and BALANCE were the whole-record running
 * total at every date — while the last column echoed the typed date and made the screen look responsive.
 *
 * It is now true, and true for one reason: `leaveBalances` takes an optional `asOf` and `employeeBalanceRows`
 * passes it the same date it passes the breakdown. Every figure in a row answers for the same date, and the
 * CSV/Excel export carries the same dated figures because it renders from the same `employeeBalanceRows`.
 * If you ever add a column, take its figure from one of those two reads — a third source is how this
 * happened.
 */

export default async function EmployeeBalancesPage({
  searchParams,
}: {
  searchParams: Promise<{
    emp?: string;
    asOf?: string;
    q?: string;
    type?: string | string[];
    dir?: string;
  }>;
}) {
  const { s: session, scopeIds } = await scopedAdmin();
  const t = await getTranslations('leave');
  const tInq = await getTranslations('leave.inquiry');
  const tMe = await getTranslations('me');
  const locale = await getLocale();
  const sp = await searchParams;
  const arr = (v?: string | string[]): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

  const employees = sortInquiryEmployees(await listEmployees(session, scopeIds), locale);
  // No employee picked ⇒ the first by company then name (20c699f8 §1). Terminated staff are NOT filtered
  // out: their leave position is exactly what HR looks up after someone leaves.
  const selected = pickInquiryEmployee(employees, sp.emp);

  const asOf = sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : todayInKualaLumpur();
  const q = sp.q?.trim() || undefined;
  const typeIds = arr(sp.type);
  const dir: 'asc' | 'desc' = sp.dir === 'desc' ? 'desc' : 'asc';

  const [rows, leaveTypes] = await Promise.all([
    selected
      ? employeeBalanceRows(session, selected.employmentId, asOf, locale, { q, typeIds, dir })
      : Promise.resolve([]),
    listLeaveTypes(session, { locale }),
  ]);

  // Every column still renders through this ONE formatter — no per-column rounding, and a null figure
  // stays an em dash rather than becoming a "0.00" HR would read as a real zero balance.
  const num = (v: number | null) => formatDays(v);

  const params = () => {
    const p = new URLSearchParams();
    if (selected) p.set('emp', selected.employmentId);
    if (sp.asOf) p.set('asOf', asOf);
    if (q) p.set('q', q);
    for (const id of typeIds) p.append('type', id);
    return p;
  };
  const sortHref = () => {
    const p = params();
    p.set('dir', dir === 'asc' ? 'desc' : 'asc');
    return `/leave/employee-balances?${p.toString()}`;
  };
  const exportHref = (format: 'csv' | 'xlsx') => {
    const p = params();
    p.set('dir', dir);
    p.set('format', format);
    return `/leave/employee-balances/export?${p.toString()}`;
  };
  // A balance row opens that leave type's transactions for the same employee (953be4b0).
  const recordsHref = (leaveTypeId: string) =>
    `/leave/employee-records?emp=${selected?.employmentId ?? ''}&type=${leaveTypeId}`;

  // 38b94df7 — the Employee box is a SEARCH box, not a list of everyone. Captions are resolved HERE and
  // handed over as plain strings: EmployeeSearchField is a client island and a translator closure crossing
  // that boundary is a 500 on every request that tsc, the suite and `next build` all stay green through
  // (r123). They live in `leave.inquiry` rather than reaching into `payroll.individualPayslip` because the
  // coverage guard reads one namespace per file. NOTE the `empSearch*` prefix: `searchPlaceholder` in this
  // same namespace is already taken by the leave-CODE box beside it ("Search leave code"), which is a
  // different control and must keep its own caption — the two boxes are deliberately NOT merged.
  const empSearchLabels = {
    placeholder: tInq('empSearchPlaceholder'),
    ariaLabel: tInq('empSearchAriaLabel'),
    resultsLabel: tInq('empSearchResultsLabel'),
    noMatches: tInq('empSearchNoMatches'),
    clear: tInq('empSearchClear'),
  };
  const empSearchOptions = employees.map((e) => ({
    value: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    secondary: e.company,
  }));

  const filterFields: FilterField[] = [
    {
      kind: 'multi',
      name: 'type',
      label: t('filters.leaveType'),
      ariaLabel: t('filters.leaveType'),
      options: leaveTypes.map((lt) => ({ value: lt.id, label: lt.name })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.leaveType') }),
    },
  ];
  const filterValues = { type: typeIds };
  const filterLabels = {
    filter: t('filters.filter'),
    apply: t('filters.apply'),
    clearAll: t('filters.clearAll'),
    activeCount: t('filters.activeCount', { count: typeIds.length ? 1 : 0 }),
    selectAll: t('filters.selectAll'),
    deselectAll: t('filters.deselectAll'),
  };
  // Clearing filters must not clear the employee — the chips' base action carries the selection.
  const chipAction = `/leave/employee-balances${selected ? `?emp=${selected.employmentId}` : ''}`;

  // Layout (feedback 026e16b9) — presentation only, no figure, rule or setting is touched.
  //
  // Measured in a browser before changing anything: window 1512, content area capped at 1232 by max-w-7xl,
  // of which the inquiry rail + gap took 248, leaving the table 982px for 1118px of columns — a 136px
  // horizontal scroll, with LEAVE CODE squeezed to 237px (wrapping "Hospitalization Leave" onto two lines)
  // while ADJUSTMENT sat at 104 and OVERUTILIZED at 112 for a two-decimal number. That is the reporter's
  // complaint exactly: the text column starved while the numeric ones spread.
  //
  // Three changes, in order of how much width each returns:
  //   • the container cap goes to 100rem, so a wide monitor is actually used (at 1512 this alone returns the
  //     ~32px the cap was eating; at 1920 it returns ~440px). It stays capped rather than going full-bleed
  //     because an uncapped table on an ultrawide display is unreadable in the other direction.
  //   • the rail narrows (leave-inquiry-nav) and the gap tightens: ~56px back.
  //   • numeric cells drop to px-2 — 9 numeric columns × 8px = ~72px back — and gain whitespace-nowrap so a
  //     figure can never wrap mid-number. The HEADINGS still wrap on their spaces, which is what keeps the
  //     numeric columns narrow: the header word, not the number, was setting their width.
  // The leave-type column takes the recovered slack (w-[26%]) with a min width so it does not collapse on a
  // small screen; the table stays inside overflow-x-auto, so anything that still cannot fit scrolls the
  // table rather than the page.
  // NOTE the asymmetry, which is the whole trick: the HEADINGS must keep wrapping (no whitespace-nowrap on
  // th) — "Pending approval" over two lines is what holds that column to the width of "approval" instead of
  // the width of both words — while the VALUES must not wrap, so a figure never breaks across lines.
  const th = 'px-2 py-2 font-medium';
  const thNum = `${th} text-right`;
  const tdNum = 'whitespace-nowrap px-2 py-2 text-right tabular-nums';

  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader title={tInq('balancesTitle')} description={tInq('balancesDescription')} />
      <div className="flex flex-col gap-4 sm:flex-row">
        <LeaveInquiryNav active="balances" employmentId={selected?.employmentId} />
        <div className="min-w-0 flex-1 space-y-4">
          {/* Employee + as-at date in ONE GET form: both re-run the same breakdown, so submitting them
              together avoids a round trip that silently resets the other. */}
          <div className="flex flex-wrap items-end gap-2">
            <form method="get" action="/leave/employee-balances" className="flex flex-wrap items-end gap-2">
            {/* 38b94df7: the plain <select> listing all 40 employments is replaced by the SAME searchable
                field, posting the SAME `name="emp"` under the same GET form — the hidden input carries the
                committed employmentId, so the query string, the export links, the chip action and the
                "clearing filters must not clear the employee" rule are all untouched. `htmlFor`/`id` rather
                than wrapping, because the control is a div with two inputs, not one labelable element. */}
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <label htmlFor="balances-emp">{tInq('employee')}</label>
              <EmployeeSearchField
                id="balances-emp"
                name="emp"
                employees={empSearchOptions}
                value={selected?.employmentId ?? null}
                labels={empSearchLabels}
                className="w-72"
              />
            </div>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {tMe('leaveBalanceTable.asAtDate')}
              <input type="date" name="asOf" defaultValue={asOf} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('filters.search')}
              <input
                name="q"
                defaultValue={q ?? ''}
                placeholder={tInq('searchPlaceholder')}
                aria-label={tInq('searchPlaceholder')}
                className={`${inputCls} w-48`}
              />
            </label>
            {typeIds.map((id) => (
              <input key={id} type="hidden" name="type" value={id} />
            ))}
            <input type="hidden" name="dir" value={dir} />
            <Button type="submit" size="sm" variant="secondary">
              {tMe('leaveBalanceTable.apply')}
            </Button>
            </form>

            {/* FilterPanel renders its OWN GET form, so it is a SIBLING of the search form, never a
                child. Nested forms are invalid HTML: the parser silently discards the inner tags, the
                panel's fields get absorbed into the outer form, and its Apply button submits the outer
                one. It happened to behave here because both target the same action — but that is
                coincidence, not design, and the optional `hidden` prop added for the two-listing page
                would have made the two forms disagree. Wrapped in a flex row so the layout is unchanged. */}
            <FilterPanel
              action="/leave/employee-balances"
              fields={filterFields}
              values={filterValues}
              labels={filterLabels}
            />
            <div className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs">
              <span className="text-muted-foreground">{t('filters.export')}:</span>
              <Link href={exportHref('csv')} className="font-medium text-primary hover:underline">
                {t('filters.exportCsv')}
              </Link>
              <span className="text-muted-foreground">·</span>
              <Link href={exportHref('xlsx')} className="font-medium text-primary hover:underline">
                {t('filters.exportExcel')}
              </Link>
            </div>
          </div>

          <FilterChips action={chipAction} fields={filterFields} values={filterValues} labels={filterLabels} />

          <Card className="overflow-hidden">
            <div className="border-b border-border px-4 py-3 text-sm font-medium">
              {selected ? `${selected.name} · ${selected.company}` : tInq('noEmployees')}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                {/* 026e16b9: no `tracking-wide` on these inquiry tables. Measured live, the extra letter-spacing
                      cost this header row 23px across eleven columns — the last of the horizontal overflow.
                      Uppercase small-caps headings read fine without it. */}
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th
                      className={`${th} w-[26%] min-w-[13rem]`}
                      aria-sort={dir === 'asc' ? 'ascending' : 'descending'}
                    >
                      <Link
                        href={sortHref()}
                        aria-label={t('filters.sortAria', { column: tInq('colLeaveCode') })}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {tInq('colLeaveCode')}
                        <span aria-hidden className="text-[10px]">
                          {dir === 'asc' ? '▲' : '▼'}
                        </span>
                      </Link>
                    </th>
                    <th className={th}>{tInq('colEntitlementYear')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colYtdEntitled')}</th>
                    <th className={thNum}>{tInq('colBroughtForward')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colTaken')}</th>
                    <th className={thNum}>{tInq('colPendingApproval')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colAdjustment')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colOverutilized')}</th>
                    <th className={thNum}>{tInq('colForfeitedBf')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colBalance')}</th>
                    <th className={th}>{tInq('colDate')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={11} className="px-4 py-6 text-center text-muted-foreground">
                        {tInq('noRows')}
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.leaveTypeId} className="hover:bg-muted/40">
                      <td className="px-2 py-2">
                        <Link href={recordsHref(r.leaveTypeId)} className="font-medium text-primary hover:underline">
                          {r.code || r.leaveType}
                        </Link>
                        <span className="ml-1.5 text-xs text-muted-foreground">{r.leaveType}</span>
                        {/* r209 — WHICH TABLE THIS PERSON RESOLVED TO. The reporter's words: "a screen that
                            shows you which table each person got, rather than leaving you to work it out
                            from the balance". The figure alone cannot answer it — several Medical tables
                            grant the same days at some service lengths. It goes in the LEAVE CODE column
                            rather than a twelfth one: 026e16b9 measured this table to the pixel and the
                            eleven it has already overflow a laptop. */}
                        {r.entitlementTemplateName && (
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {tInq('resolvedEntitlementTable', { name: r.entitlementTemplateName })}
                          </span>
                        )}
                        {/* r209 — the same sentence the employee's own grid carries, from the same row, so
                            HR and the employee are never told two different stories about one pool. */}
                        {r.sharedBalance && otherContributors(r.sharedBalance, r.leaveType).length > 0 && (
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {tInq('sharedBalanceWith', {
                              pool: r.sharedBalance.sourceLeaveTypeName,
                              types: otherContributors(r.sharedBalance, r.leaveType).join(', '),
                            })}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted-foreground">
                        {r.entitlementYear ?? '—'}
                      </td>
                      {/* 31e39d74 — the caption sits UNDER the figure, in the existing column. No new
                          column: eleven columns already overflow this table on a laptop (026e16b9 measured
                          the last 23px out of the header), and the status belongs to YTD Entitled rather
                          than standing on its own. The figure itself is untouched. */}
                      <td className={tdNum}>
                        <div>{num(r.ytdEntitled)}</div>
                        {entitlementStatusNeedsNotice(r.entitlementStatus) && (
                          <div
                            className="mt-0.5 whitespace-nowrap text-[11px] text-amber-700 dark:text-amber-500"
                            title={tMe(`leaveBalanceTable.${ENTITLEMENT_STATUS_TIP_KEY[r.entitlementStatus]!}`)}
                          >
                            {tMe(`leaveBalanceTable.${ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]}`)}
                          </div>
                        )}
                      </td>
                      <td className={tdNum}>{num(r.broughtForward)}</td>
                      <td className={tdNum}>{num(r.taken)}</td>
                      <td className={tdNum}>{num(r.pending)}</td>
                      <td className={tdNum}>{num(r.adjustment)}</td>
                      <td className={tdNum}>{num(r.overutilized)}</td>
                      <td className={tdNum}>{num(r.forfeitedBf)}</td>
                      <td className={`${tdNum} font-medium`}>{num(r.balance)}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted-foreground">{asOf}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
