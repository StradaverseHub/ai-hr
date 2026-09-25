import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { LEAVE_FIGURE_LABEL_KEY, LEAVE_FIGURE_NS } from '@/lib/leave-figure-labels';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees, listLeaveTypes } from '@/core/read';
import { todayInKualaLumpur } from '@/core/leave';
import { Button, Card, PageHeader, inputCls } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { LeaveInquiryNav } from '@/components/leave/leave-inquiry-nav';
import { TableFullscreen } from '@/components/leave/table-fullscreen';
import { EmployeeSearchField } from '@/components/employee-search-field';
import { pickInquiryEmployee, sortInquiryEmployees } from '@/lib/leave-inquiry';
// 4a1abc4a: HR's copy of the employee's own balance grid must print the figures identically to it.
import { dayPluralCategory, formatDays } from '@/lib/day-format';
// 31e39d74: HR's grid captions a 0.00 exactly as the employee's own grid does — one mapping, one wording.
import {
  ENTITLEMENT_STATUS_LABEL_KEY,
  ENTITLEMENT_STATUS_TIP_KEY,
  entitlementStatusNeedsNotice,
} from '@/lib/entitlement-status';
// 2a57a007 (r340): `pooledEntitlementCaption` is the ONE place that decides a pooled borrower says something
// else entirely — see `entitlementCaptionCell` below, and the function's own header for the r209 incident it
// exists to keep shut. The export next door calls the same function for the same row.
import { pooledEntitlementCaption, isPoolBorrower, otherContributors, poolBadges } from '@/lib/shared-leave-balance';
// r219 (7966ee35) — HR's half of "why is Replacement Leave in Lieu not available for this person". The
// employee's own screen gained the same notice from the same read and the same component, which is the
// point: an employee ringing HR about a missing button and the HR admin looking that person up must be
// given ONE cause, not two descriptions of one configuration (8ebf77ae's lesson, third occurrence).
import { isReplacementLeaveType } from '@/core/ess-view';
import { replacementRequestAvailability } from '@/packs/leave/service';
import { ReplacementAvailabilityNotice } from '@/components/leave/replacement-availability-notice';
// r242 — the SAME read-only side-sheet /me and /admin/personnel/[id] already open. A client component that
// imports no db client and no server action, so mounting it from this RSC crosses no boundary; every figure
// it shows arrives as a prop, taken off the row below.
import { EntitlementBreakdown } from '@/components/leave/EntitlementBreakdown';
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
 *
 * THE EXPLANATION BUTTON (r242). Every row carries an Explain button opening the read-only entitlement
 * side-sheet that already opens on /me and on the personnel record — the rule that applied, the dates it
 * was worked out from, the entitlement step by step and the balance component by component. It is the SAME
 * component, and it is fed from the SAME breakdown `employeeBalanceRows` already loaded for the row
 * (`r.breakdown`): this page performs no read of its own for it, and computes nothing. That is the same
 * rule the paragraph above states about columns, applied to the panel — an explanation fetched separately
 * would eventually explain a figure other than the one it sits beside.
 *
 * `applyEssConfig` is deliberately NOT passed, which is the HR/self-service asymmetry stated above seen
 * from the panel's side: per-component ESS hiding is a rule about what an EMPLOYEE is shown, never about
 * what HR may look at, so HR gets every line — exactly as /admin/personnel/[id] already does.
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
  const tf = await getTranslations(LEAVE_FIGURE_NS); // 7da0a4e7 — one name per figure; see lib/leave-figure-labels.ts
  const locale = await getLocale();
  const sp = await searchParams;
  const arr = (v?: string | string[]): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

  const employees = sortInquiryEmployees(await listEmployees(session, scopeIds), locale);
  // No employee picked ⇒ the first by company then name (20c699f8 §1). Terminated staff are NOT filtered
  // out: their leave position is exactly what HR looks up after someone leaves.
  const selected = pickInquiryEmployee(employees, sp.emp);

  const asOf = sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : todayInKualaLumpur();
  // r219 — TODAY, kept as its own value rather than folded into the line above. The as-at fallback is a
  // pinned contract with the export route (test/leave-balance-as-at-date.test.ts: both sides must validate
  // and fall back identically, or an export link resolves to a different date than the page it was clicked
  // from), and the availability read below deliberately does NOT use `asOf` — see its own note.
  const today = todayInKualaLumpur();
  const q = sp.q?.trim() || undefined;
  const typeIds = arr(sp.type);
  const dir: 'asc' | 'desc' = sp.dir === 'desc' ? 'desc' : 'asc';

  const [rows, leaveTypes, replacementRequest] = await Promise.all([
    selected
      ? employeeBalanceRows(session, selected.employmentId, asOf, locale, { q, typeIds, dir })
      : Promise.resolve([]),
    listLeaveTypes(session, { locale }),
    // r219 — may THIS employee ask to be credited for time they already worked, and if not, why not.
    //
    // ⚠️ ASKED AS OF TODAY, NOT AS OF THE AS-AT DATE, and that asymmetry with every figure on this screen
    // is deliberate. The columns answer "where did this person stand on `asOf`"; this answers "can they
    // press the button now", which is a question about the present whatever date HR has typed above. An
    // eligibility verdict resolved against a back-date would be a true sentence about the wrong day, and
    // the screen has nothing that could tell the reader which of the two it was reading.
    selected
      ? replacementRequestAvailability(session, selected.employmentId, today)
      : Promise.resolve({ allowed: false } as const),
  ]);
  // Same scope as the employee's own page: a tenant with no replacement leave type in its catalogue has
  // nothing to explain, so it is shown nothing. Read off the full catalogue by ROLE (`isReplacementLeaveType`),
  // not off `rows` — those are narrowed by the leave-type filter above, and a notice that disappeared
  // because HR ticked "Annual Leave" would be worse than one that was never there.
  const tenantHasReplacementLeave = leaveTypes.some(isReplacementLeaveType);

  // Every column still renders through this ONE formatter — no per-column rounding, and a null figure
  // stays an em dash rather than becoming a "0.00" HR would read as a real zero balance.
  const num = (v: number | null) => formatDays(v);

  /**
   * 2a57a007 — WHOSE DAYS MADE UP THIS FIGURE, BESIDE THE FIGURE.
   *
   * Share on the pool's row is a SUM over every type that borrows from it, and a sum cannot be read: the
   * reporter's own account has TWO pools (Emergency → Annual and Compassionate → Special), so "3.00" on the
   * Annual row could be three days of Emergency Leave, or two of one code and one of another. One badge per
   * contributing type, carrying that type's own LEAVE CODE and, in its tooltip, that type's own figure.
   *
   * ⚠️ THE BADGE IS DATA, NEVER THE LITERAL "EL". It is `code` off the contributing leave type, resolved by
   * core/read.ts in the same pass that computed the figure (lib/shared-leave-balance.ts `poolBadges`). A
   * hardcoded "EL" would be right on one tenant's Annual Leave row and wrong on the Special Leave row three
   * rows below it, on the same screen, for the same employee.
   *
   * ⚠️ THE POOL'S ROW ONLY. On a BORROWER's row the figure is that row's own days and the row is already
   * named by its own Leave Code cell; a badge there would say "EL" beside the Emergency Leave row.
   *
   * The tooltip is a native `title`, so it is IN THE HTML of a plain GET — the render check can read it, and
   * it needs no hover, no JavaScript and no client island on a screen that already carries thirteen columns.
   * `cat` SELECTS the plural and `v` PRINTS the figure — see lib/day-format.ts `dayPluralCategory` for why
   * those are two arguments and not one.
   */
  const poolBadgeCells = (
    r: (typeof rows)[number],
    which: 'share' | 'pendingShare',
    tipKey: 'shareBadgeTip' | 'pendingShareBadgeTip',
  ) => {
    if (!r.sharedBalance || isPoolBorrower(r)) return null;
    const badges = poolBadges(r.sharedBalance, which);
    if (badges.length === 0) return null;
    return (
      <div className="mt-0.5 flex flex-wrap justify-end gap-1" data-testid={`pool-badges-${which}`}>
        {badges.map((c) => (
          <span
            key={c.leaveTypeId}
            className="rounded border border-border px-1 text-[10px] font-medium text-muted-foreground"
            title={tMe(`leaveBalanceTable.${tipKey}`, {
              v: formatDays(c[which]),
              cat: dayPluralCategory(c[which], locale),
              type: c.leaveType,
              pool: r.sharedBalance!.sourceLeaveTypeName,
            })}
          >
            {c.code ?? c.leaveType}
          </span>
        ))}
      </div>
    );
  };

  /**
   * 2a57a007 (r340) — WHY THIS ROW'S ENTITLEMENT READS WHAT IT READS, IN THE RIGHT VOICE.
   *
   * 31e39d74 put this caption under the Earned to Date figure and made it AMBER, because every state it
   * could describe was a misconfiguration somebody had to go and fix. A pooled borrower is not one: a leave
   * type that draws on another type's pool has no entitlement table BECAUSE it borrows, and telling HR to
   * create one is the single instruction that would stop the borrowing (r209's incident — read
   * lib/shared-leave-balance.ts before changing this). So the voice splits with the fact: amber for a
   * defect, muted for a normal arrangement, and `entitlementStatusCaption` decides which — once, shared with
   * the export, rather than twice on two screens that then disagree.
   */
  const entitlementCaptionCell = (r: (typeof rows)[number]) => {
    // THE POOLED BRANCH OUTRANKS THE STATUS, and it is MUTED rather than amber: nothing is wrong here.
    const pooled = pooledEntitlementCaption(r);
    if (pooled) {
      return (
        <div
          className="mt-0.5 whitespace-nowrap text-[11px] text-muted-foreground"
          title={tMe(`leaveBalanceTable.${pooled.tipKey}`, { pool: pooled.pool })}
          data-testid="entitlement-pooled-caption"
        >
          {tMe(`leaveBalanceTable.${pooled.labelKey}`, { pool: pooled.pool })}
        </div>
      );
    }
    // 31e39d74, byte for byte as it was: every OTHER row's caption, in amber, off the shared status maps.
    if (!entitlementStatusNeedsNotice(r.entitlementStatus)) return null;
    return (
      <div
        className="mt-0.5 whitespace-nowrap text-[11px] text-amber-700 dark:text-amber-500"
        title={tMe(`leaveBalanceTable.${ENTITLEMENT_STATUS_TIP_KEY[r.entitlementStatus]!}`)}
      >
        {tMe(`leaveBalanceTable.${ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]}`)}
      </div>
    );
  };

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
  // r242 — what the panel's own as-at GET form must carry back. The panel posts `asOf` (its own field), so
  // everything ELSE that narrows this screen rides as hidden inputs or pressing Apply inside the sheet would
  // silently drop the employee, the search and the leave-type filter — the same carrier pattern the search
  // form above uses, and the reason `params()` is not reused: that one deliberately re-sends `asOf`.
  const panelHiddenParams: Record<string, string | string[]> = {};
  if (selected) panelHiddenParams.emp = selected.employmentId;
  if (q) panelHiddenParams.q = q;
  if (typeIds.length) panelHiddenParams.type = typeIds;
  panelHiddenParams.dir = dir;

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
      {/* d990f14a — NO RAIL. The tab bar is rendered below, between the filters and the table, so the
          table gets the whole width of the page instead of the 192px the rail and its gap were taking. */}
      <div className="min-w-0 space-y-4">
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

          {/* d990f14a — THE TAB BAR SITS HERE, under the search bar and its chips and above the table it
              scopes. The chips only render when a filter is active, so the search bar is directly above the
              bar in the ordinary case, which is what the reporter asked for; putting the bar between the
              search fields and their own active-filter chips would split one control into two. */}
          <LeaveInquiryNav active="balances" employmentId={selected?.employmentId} carry={{ q, type: typeIds }} />

          {/* r219 (7966ee35) — why Replacement Leave in Lieu is not available to the employee named on the
              card below. Directly above that card so it is unambiguously about THIS person, and phrased
              for an administrator ("this employee") by the same component that phrases it for the employee
              themselves — one map, one cause, two subjects. Nothing renders when they can submit. */}
          {selected && tenantHasReplacementLeave && (
            <ReplacementAvailabilityNotice availability={replacementRequest} audience="admin" />
          )}

          <Card className="overflow-hidden">
            <div className="border-b border-border px-4 py-3 text-sm font-medium">
              {selected ? `${selected.name} · ${selected.company}` : tInq('noEmployees')}
            </div>
            <TableFullscreen
              title={tInq('balancesTitle')}
              subtitle={selected ? `${selected.name} · ${selected.company}` : undefined}
              openLabel={tInq('fullScreen')}
              closeLabel={tInq('fullScreenClose')}
              escHint={tInq('fullScreenEsc')}
            >
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
                    {/* r279 — FULL ENTITLEMENT sits BEFORE Earned to Date, in the Explain panel's own order
                        (Eligible, then what has been earned against it). It is the thirteenth column and the
                        first FIGURE added since 026e16b9 measured this table; it is placed here rather than at
                        the end because a full-year allowance read three columns away from the earned figure it
                        explains is the mismatch this item exists to close. The table already scrolls in
                        `overflow-x-auto` above. */}
                    <th className={thNum}>{tMe('leaveBalanceTable.colFullEntitlement')}</th>
                    <th className={thNum}>{tf(LEAVE_FIGURE_LABEL_KEY.ytdEntitled)}</th>
                    <th className={thNum}>{tInq('colBroughtForward')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colTaken')}</th>
                    <th className={thNum}>{tInq('colPendingApproval')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colAdjustment')}</th>
                    {/* 39136455 — SHARE / PENDING SHARE, between Adjustment and Balance exactly as the
                        reporter asked. They are the pooled transfer Emergency Leave used to hide by
                        mirroring Annual Leave's figures: a minus on the row that lends the days out, a plus
                        of the same size on the row that used them. */}
                    <th className={thNum}>{tMe('leaveBalanceTable.colShare')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colPendingShare')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colOverutilized')}</th>
                    <th className={thNum}>{tInq('colForfeitedBf')}</th>
                    <th className={thNum}>{tMe('leaveBalanceTable.colBalance')}</th>
                    <th className={th}>{tInq('colDate')}</th>
                    {/* r242 — the LAST column, and the only one that is not a figure. It is last on
                        purpose: 026e16b9 measured this table to the pixel, and a control column at the end
                        is the one addition that pushes no numeric column around. (It was the twelfth when
                        r242 added it; r279's Full Entitlement made it the thirteenth without moving it.) */}
                    <th className={th}>{tInq('colExplanation')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={15} className="px-4 py-6 text-center text-muted-foreground">
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
                            rather than beside the figures: 026e16b9 measured the FIGURE columns to the
                            pixel and the eleven of them already overflow a laptop.
                            ⚠️ r242 ADDED A TWELFTH COLUMN and this comment used to deny one existed. The
                            measurement is still right, because that column holds the Explanation CONTROL
                            rather than a number — but a live comment asserting the opposite of the file
                            three lines below it is how the next reader is misled. It is also, on its own,
                            the plan's "rule that applied": this caption is already on the row.
                            ⚠️ r279 ADDED A THIRTEENTH, AND IT IS A FIGURE. Full Entitlement is the first
                            numeric column added since that measurement, so the twelve-column overflow this
                            comment describes is now a thirteen-column one. It was accepted deliberately:
                            the reporter asked for the full-year allowance ON the grid, and the alternative —
                            a column three places from the earned figure it explains — is what the item
                            exists to close. The resolved-table caption still belongs here, not beside the
                            figures. */}
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
                      {/* r279 — the whole year's allowance for this person's band. `num()` is the shared
                          formatter, so a type with no entitlement table (eligibleDays = 0 — fifteen of the
                          sixteen today) prints a clean 0.00 with the status caption beside it explaining why,
                          and only a row with NO breakdown at all (null) falls through to the em dash. */}
                      <td className={tdNum}>{num(r.fullEntitlement)}</td>
                      {/* 31e39d74 — the caption sits UNDER the figure, in the existing column. No new
                          column: eleven columns already overflow this table on a laptop (026e16b9 measured
                          the last 23px out of the header), and the status belongs to YTD Entitled rather
                          than standing on its own. The figure itself is untouched. */}
                      <td className={tdNum}>
                        <div>{num(r.ytdEntitled)}</div>
                        {entitlementCaptionCell(r)}
                      </td>
                      <td className={tdNum}>{num(r.broughtForward)}</td>
                      <td className={tdNum}>{num(r.taken)}</td>
                      <td className={tdNum}>{num(r.pending)}</td>
                      <td className={tdNum}>{num(r.adjustment)}</td>
                      {/* 2a57a007 — the figure, and under it one badge per contributing leave type. Same
                          shape as the YTD Entitled cell three columns left: a caption UNDER the figure, in
                          the existing column, because thirteen columns already overflow this table on a
                          laptop (026e16b9 measured the last 23px out of the header). */}
                      <td className={tdNum}>
                        <div>{num(r.share)}</div>
                        {poolBadgeCells(r, 'share', 'shareBadgeTip')}
                      </td>
                      <td className={tdNum}>
                        <div>{num(r.pendingShare)}</div>
                        {poolBadgeCells(r, 'pendingShare', 'pendingShareBadgeTip')}
                      </td>
                      <td className={tdNum}>{num(r.overutilized)}</td>
                      <td className={tdNum}>{num(r.forfeitedBf)}</td>
                      <td className={`${tdNum} font-medium`}>{num(r.balance)}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted-foreground">{asOf}</td>
                      {/* r242 — "how was this figure arrived at", answered from the row HR is already
                          looking at. `data={r.breakdown}` is the object the row's own figures came out of
                          (app/leave/employee-balances/rows.ts) — not a second read and not a recomputation.
                          `summary.available` is the balance row's authoritative bookable figure, the one
                          line of the panel that is not breakdown-derived, passed exactly as /leave and
                          /admin/personnel/[id] pass it. No breakdown resolved ⇒ no button, rather than a
                          button opening a panel of em dashes. */}
                      <td className="px-2 py-2">
                        {/* ⚠️ AN EM DASH, NOT AN EMPTY CELL, WHERE NO BREAKDOWN RESOLVED. Every other
                            column in this table renders a null figure as "—"; a blank cell under a
                            heading reads as a screen that failed rather than as a row with nothing to
                            explain. Same convention, one column further right. */}
                        {r.breakdown ? (
                          <EntitlementBreakdown
                            data={r.breakdown}
                            summary={{ available: r.available }}
                            visual={r.visual}
                            asOf={asOf}
                            action="/leave/employee-balances"
                            hiddenParams={panelHiddenParams}
                            triggerLabel={tInq('explainAction')}
                            hrExplanation={r.hrExplanation}
                            triggerClassName="whitespace-nowrap rounded-md border border-input bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-muted dark:hover:bg-muted/40"
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </TableFullscreen>
          </Card>
        </div>
    </div>
  );
}
