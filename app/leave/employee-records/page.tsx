import Link from 'next/link';
import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees, listLeaveRequestsPage, listLeaveTypes } from '@/core/read';
import { Button, Card, EmployeeName, PageHeader, inputCls } from '@/components/ui';
import {
  CollapsibleEmployeePanel,
  EmployeeScopePanel,
  type ScopeEmployee,
} from '@/components/collapsible-employee-panel';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { LeaveInquiryNav } from '@/components/leave/leave-inquiry-nav';
import { TableFullscreen } from '@/components/leave/table-fullscreen';
import { AdminCancelLeaveDialog } from '@/components/leave/admin-cancel-leave-dialog';
import { adminCancelLeaveAction } from '@/app/leave/actions';
import { selectInquiryEmployee, sortInquiryEmployees } from '@/lib/leave-inquiry';
import { durationLabel } from '@/lib/leave-duration';
// 4a1abc4a: this screen printed the raw day count ("3") beside Employee Balances' "3.00" — the reported
// drift, between two tabs of the same Leave Inquiry nav. One formatter for both.
import { formatDays } from '@/lib/day-format';
// fef49b9a — the shared paid/unpaid derivation (see lib/leave-split.ts on why it is not four subtractions).
import { leaveDisplaySplit } from '@/lib/leave-split';
import { canAdminCancelLeave, LEAVE_STATUS_PILL, LEAVE_STATUS_PILL_DEFAULT } from '@/lib/leave-status';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { Pager, type PagerHrefOver } from '@/components/pager';
import { pageState, parsePageQuery } from '@/lib/pagination';

/**
 * Employee Leave Record (feedback 953be4b0) — the transactions behind a balance: every leave request for
 * one employee, opened by clicking a leave row on Employee Balances.
 *
 * Reads the existing leave-request projection (`listLeaveRequestsPage`) narrowed to (employment, leave
 * type) rather than deriving a second history, so this page, the admin history table on /leave and the
 * approvals inbox always describe the same records. Attachments link to the SAME per-request route the
 * employee's own page uses, whose authorization is unchanged — being able to read a leave record here does
 * not by itself grant the document behind it.
 *
 * fe3eb141 — CONSOLIDATION, STEP 1 OF 2. The reporter asked to fold the Requests subsection on
 * /leave into this page and then delete it. This page now carries the three things they named:
 *
 *   - the Cancel Leave action, to the RIGHT of Final Approval Date, exactly as asked;
 *   - the short leave REFERENCE (`#7b096403`) — it is a real handle, not decoration: the `q` search on
 *     both screens matches a uuid prefix (core/read.ts listLeaveRequestsPage `isRef`), so the id was
 *     already searchable here with nothing on screen to reveal it;
 *   - a STATUS column, without which "why is there no Cancel button on this row" is unanswerable.
 *
 * STEP 2 — deleting the Requests subsection — IS NOT DONE, deliberately. That subsection is not a
 * duplicate of this page: it is the ORG-WIDE register (this one is hard-narrowed to a single
 * employment) and it is the only home of four other controls. The enumeration is in
 * test/leave-records-cancel.test.ts; do not delete it without reading that.
 */

const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

/**
 * 9949f91a (r369) — THIS SCREEN'S OWN PANEL COOKIE, never shared with Employee Balances. One key per
 * collapse state a reader expects to set separately: two mounts sharing a key means every move between the
 * two tabs undoes the last answer, so the first thing each switch does is fight the previous one.
 */
const PANEL_COOKIE = 'leave-records-panel';

export default async function EmployeeLeaveRecordPage({
  searchParams,
}: {
  searchParams: Promise<{
    emp?: string;
    type?: string | string[];
    status?: string | string[];
    q?: string;
    from?: string;
    to?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
    toast?: string;
    error?: string;
  }>;
}) {
  const { s: session, scopeIds } = await scopedAdmin();
  const t = await getTranslations('leave');
  const tInq = await getTranslations('leave.inquiry');
  const locale = await getLocale();
  const sp = await searchParams;
  const arr = (v?: string | string[]): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

  const employees = sortInquiryEmployees(await listEmployees(session, scopeIds), locale);
  /**
   * 9949f91a (r369) — NO EMPLOYEE PICKED ⇒ NOBODY. The retired rule, quoted from lib/leave-inquiry.ts: "No
   * employee picked ⇒ the first by company then name (20c699f8 §1)." The reporter asked for
   * "Select an employee to view their leave records" instead of the screen quietly opening on whoever sorted
   * first — which, with the panel beside it marking nobody Selected, made the two halves of the screen
   * disagree about who was being looked at. SCREENS ONLY: the export route keeps the fallback.
   *
   * POST-GUARD: an id outside the fenced list selects nothing, and this is the value the panel is handed.
   */
  const selected = selectInquiryEmployee(employees, sp.emp);
  /** The panel is fed from the SAME `listEmployees` read — a `.map`, never a second, wider employee source. */
  const panelEmployees: ScopeEmployee[] = employees.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    company: e.company,
    companyId: e.companyId,
    department: e.department,
    departmentId: e.departmentId,
    businessUnit: e.businessUnit,
    businessUnitId: e.businessUnitId,
    // DERIVED ON THE SERVER: the browser gets this wrong by a day across MYT midnight.
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));
  /** Read on the SERVER, so the first paint is already right rather than opening and folding (r320). */
  const panelDefaultOpen = (await cookies()).get(PANEL_COOKIE)?.value !== '0';

  const typeIds = arr(sp.type);
  const statuses = arr(sp.status).filter((s) => (LEAVE_STATUSES as readonly string[]).includes(s));
  const q = sp.q?.trim() || undefined;
  const from = sp.from || undefined;
  const to = sp.to || undefined;
  // Default order is newest REQUEST first — `applied` desc is exactly that (leave_request.created_at).
  const sort = sp.sort || 'applied';
  const dir: 'asc' | 'desc' = sp.dir === 'asc' ? 'asc' : 'desc';
  const pq = parsePageQuery(sp);

  const [leaveTypes, result] = await Promise.all([
    listLeaveTypes(session, { locale }),
    selected
      ? listLeaveRequestsPage(session, {
          companyIds: scopeIds,
          employmentIds: [selected.employmentId],
          leaveTypeIds: typeIds.length ? typeIds : undefined,
          statuses: statuses.length ? statuses : undefined,
          q,
          from,
          to,
          sort,
          dir,
          limit: pq.limit,
          offset: pq.offset,
        })
      : Promise.resolve({ rows: [], total: 0 }),
  ]);
  const { rows, total } = result;

  const params = () => {
    const p = new URLSearchParams();
    if (selected) p.set('emp', selected.employmentId);
    for (const id of typeIds) p.append('type', id);
    for (const s of statuses) p.append('status', s);
    if (q) p.set('q', q);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p;
  };
  const withSort = (p: URLSearchParams) => {
    p.set('sort', sort);
    p.set('dir', dir);
    return p;
  };
  const sortHref = (key: string) => {
    const p = params();
    p.set('size', String(pq.size));
    p.set('sort', key);
    p.set('dir', sort === key && dir === 'asc' ? 'desc' : 'asc');
    return `/leave/employee-records?${p.toString()}`;
  };
  // fc776376 — the shared pager builds its links here: this address carries REPEATED params (the
  // multi-select type / status filters), which a flat key/value builder would flatten.
  const pagerHref = ({ page: n, size }: PagerHrefOver) => {
    const p = withSort(params());
    if (n > 0) p.set('page', String(n));
    p.set('size', String(size ?? pq.size));
    return `/leave/employee-records?${p.toString()}`;
  };
  const exportHref = (format: 'csv' | 'xlsx') => {
    const p = withSort(params());
    p.set('format', format);
    return `/leave/employee-records/export?${p.toString()}`;
  };

  /**
   * 9949f91a (r369) — 38b94df7's EMPLOYEE SEARCH BOX IS GONE FROM THE FILTER ROW on this tab as well as on
   * Employee Balances, replaced by the shared employee panel down the left. 38b94df7's own note said it was
   * "WIDER THAN REPORTED: this page carried a byte-identical copy of the whole-list employee dropdown" — the
   * same is true of this reversal, and for the same reason: leaving one tab with a filter-row picker and the
   * other with a panel is the half-migration that guard exists to prevent.
   *
   * The five `leave.inquiry.empSearch*` keys are RETIRED IN PLACE in all six catalogues, never deleted, and
   * `recordsSearchPlaceholder` beside them is the RECORD search box and is untouched.
   */

  const filterFields: FilterField[] = [
    {
      kind: 'multi',
      name: 'type',
      label: tInq('colLeaveCode'),
      ariaLabel: tInq('colLeaveCode'),
      options: leaveTypes.map((lt) => ({ value: lt.id, label: lt.code ? `${lt.code} · ${lt.name}` : lt.name })),
      removeAriaLabel: t('filters.removeFilter', { label: tInq('colLeaveCode') }),
    },
    {
      kind: 'multi',
      name: 'status',
      label: t('filters.statusLabel'),
      ariaLabel: t('filters.statusLabel'),
      options: LEAVE_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.statusLabel') }),
    },
    {
      kind: 'date',
      name: 'from',
      label: t('filters.dateFrom'),
      ariaLabel: t('filters.dateFrom'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.dateFrom') }),
    },
    {
      kind: 'date',
      name: 'to',
      label: t('filters.dateTo'),
      ariaLabel: t('filters.dateTo'),
      removeAriaLabel: t('filters.removeFilter', { label: t('filters.dateTo') }),
    },
  ];
  const filterValues = { type: typeIds, status: statuses, from, to };
  const activeCount =
    (typeIds.length ? 1 : 0) + (statuses.length ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0);
  const filterLabels = {
    filter: t('filters.filter'),
    apply: t('filters.apply'),
    clearAll: t('filters.clearAll'),
    activeCount: t('filters.activeCount', { count: activeCount }),
    selectAll: t('filters.selectAll'),
    deselectAll: t('filters.deselectAll'),
  };
  // Clearing every filter keeps the employee — otherwise "clear all" silently jumps to someone else.
  const chipAction = `/leave/employee-records${selected ? `?emp=${selected.employmentId}` : ''}`;

  /**
   * 9949f91a (r369) — what the EMPLOYEE PANEL carries when the reader switches person: everything this screen
   * is narrowed and ordered by, and nothing scoped to the person being navigated away from. `page` is
   * deliberately ABSENT — page 4 of one employee's records is not page 4 of the next one's — while `size` is
   * a reader preference and rides along. `type` and `status` are ARRAYS and stay repeated params; flattened to
   * `a,b` they would survive the switch in the URL and match nothing on screen.
   */
  const panelPreserve: Record<string, string | string[]> = { sort, dir, size: String(pq.size) };
  if (typeIds.length) panelPreserve.type = typeIds;
  if (statuses.length) panelPreserve.status = statuses;
  if (q) panelPreserve.q = q;
  if (from) panelPreserve.from = from;
  if (to) panelPreserve.to = to;

  // Layout (feedback 026e16b9) — presentation only, and the SAME three moves as Employee Balances so the
  // two tabs do not read as different screens: a wider container cap, a narrower inquiry rail (in
  // leave-inquiry-nav) with a tighter gap, and px-2 cells. Date/day columns get whitespace-nowrap so an
  // ISO date can never break across two lines; Reason keeps its truncation but is allowed to take the
  // recovered slack rather than staying the narrowest column on the row.
  const th = 'px-2 py-2 font-medium';
  const sortableTh = (key: string, label: string) => (
    <th className={th} aria-sort={sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <Link
        href={sortHref(key)}
        aria-label={t('filters.sortAria', { column: label })}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        <span aria-hidden className="text-[10px]">
          {sort === key ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </Link>
    </th>
  );
  // A DATE DERIVED FROM AN INSTANT MUST GO THROUGH THE TENANT TIMEZONE. `appliedOn` and `decidedAt`
  // are timestamps; `toISOString()` is UTC and this product runs at UTC+8, so the previous
  // `.toISOString().slice(0, 10)` printed YESTERDAY for anything applied or decided between 00:00 and
  // 08:00 Malaysian time — including, on this very screen, the Final Approval Date column that
  // fe3eb141 anchors its Cancel action to. Same class as the r85 `core/movement.ts` fault.
  const day = (v: Date | string | null) => (v ? todayInKualaLumpur(new Date(v)) : '—');
  // fef49b9a — the tenant's own name for unpaid leave, resolved once for the page. Undefined when the
  // tenant has no UNPAID type, in which case leaveDisplaySplit uses the translated fallback label.
  const unpaidTypeName = leaveTypes.find((lt) => lt.code === 'UNPAID')?.name;


  return (
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader title={tInq('recordsTitle')} description={tInq('recordsDescription')} />

      {/* fe3eb141 — the Cancel Leave action redirects back here, so this page needs the same two
          banners /leave has. Without them a refusal (closed payroll month, approved TOIL) would land
          silently on an unchanged table. */}
      {sp.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {sp.error}
        </div>
      )}
      {sp.toast === 'adminCancelled' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('adminCancelledToast')}
        </div>
      )}

      {/**
       * d990f14a — NO TAB RAIL: the tab bar is rendered below, between the filters and the table, so the table
       * gets the whole width of the content column instead of the 192px a vertical tab rail and its gap were
       * taking. THAT IS STILL TRUE and is what test/leave-inquiry-layout.test.ts pins.
       *
       * ⚠️ 9949f91a (r369) — BUT THERE IS A LEFT-HAND COLUMN AGAIN, and it is not the tab rail. The sentence
       * here used to end "so the table gets the whole width of the PAGE". The shared employee panel sits to the
       * left now, and Hide list gives the table the whole width back the moment the reader is not hunting for
       * somebody — which is the answer to their own earlier complaint about an always-on strip. Remembered in
       * `leave-records-panel`, a different cookie from the Balances tab's.
       *
       * EVERY PROP IS PLAIN DATA OR A ReactNode: a closure across this boundary is a 500 on every request that
       * tsc, the suite and `next build` all stay green through.
       */}
      <CollapsibleEmployeePanel
        defaultOpen={panelDefaultOpen}
        cookieKey={PANEL_COOKIE}
        title={tInq('recordsTitle')}
        hideLabel={tInq('panelHide')}
        showLabel={tInq('panelShow')}
        detailHeader={
          selected ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
              <EmployeeName
                code={selected.employeeCode}
                name={selected.name}
                className="text-sm font-semibold text-foreground"
              />
              <span className="text-xs font-normal text-muted-foreground">{selected.company}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {t('requestsCountTotal', { count: total })}
              </span>
            </div>
          ) : undefined
        }
        panel={
          <Card className="p-4">
            <h2 className="text-sm font-semibold">{tInq('panelHeading')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{tInq('panelHint')}</p>
            <div className="mt-3">
              <EmployeeScopePanel
                employees={panelEmployees}
                selectedId={selected?.employmentId ?? null}
                basePath="/leave/employee-records"
                selectParam="emp"
                preserve={panelPreserve}
              />
            </div>
          </Card>
        }
      >
      <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <form method="get" action="/leave/employee-records" className="flex flex-wrap items-end gap-2">
            {/* 9949f91a — THE EMPLOYEE RIDES THE URL, chosen in the panel on the left, and is carried here so
                submitting the record search cannot silently clear the selection. Same shape as Employee
                Balances and as app/attendance/individual/page.tsx. */}
            {selected && <input type="hidden" name="emp" value={selected.employmentId} />}
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('filters.search')}
              <input
                name="q"
                defaultValue={q ?? ''}
                placeholder={tInq('recordsSearchPlaceholder')}
                aria-label={tInq('recordsSearchPlaceholder')}
                className={`${inputCls} w-56`}
              />
            </label>
            {typeIds.map((id) => (
              <input key={id} type="hidden" name="type" value={id} />
            ))}
            {statuses.map((s) => (
              <input key={s} type="hidden" name="status" value={s} />
            ))}
            {from && <input type="hidden" name="from" value={from} />}
            {to && <input type="hidden" name="to" value={to} />}
            <Button type="submit" size="sm" variant="secondary">
              {t('filters.search')}
            </Button>
            </form>

            {/* FilterPanel renders its OWN GET form, so it is a SIBLING of the search form, never a
                child. Nested forms are invalid HTML: the parser silently discards the inner tags, the
                panel's fields get absorbed into the outer form, and its Apply button submits the outer
                one. It happened to behave here because both target the same action — but that is
                coincidence, not design, and the optional `hidden` prop added for the two-listing page
                would have made the two forms disagree. Wrapped in a flex row so the layout is unchanged. */}
            <FilterPanel
              action="/leave/employee-records"
              fields={filterFields}
              values={filterValues}
              labels={filterLabels}
            />
            {/* 9949f91a — NOT OFFERED WITH NOBODY SELECTED: the export ROUTE keeps 20c699f8's
                first-employee fallback, so the link would hand back a workbook about somebody the reader never
                chose. The route is untouched; the link is not drawn. */}
            {selected && (
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
            )}
          </div>

          <FilterChips action={chipAction} fields={filterFields} values={filterValues} labels={filterLabels} />

          {/* d990f14a — see the note on the Employee Balances tab: under the search bar and its chips,
              above the table. `carry` hands on the leave-code search and the leave-type filter only. */}
          <LeaveInquiryNav active="records" employmentId={selected?.employmentId} carry={{ q, type: typeIds }} />

          {/* 9949f91a — THE PROMPT, in the reference mount's own shape: the filter row and the tab bar stay
              drawn so a reader with nobody selected can still switch tabs, and only the table is replaced.
              `tInq('noEmployees')` is a different statement — the scope holds nobody — and keeps its own case.
              The "Name · Company" strip and the record count moved into the shell's header bar above, so the
              identity is stated once rather than twice. */}
          {!selected ? (
            <Card className="overflow-hidden">
              <p className="px-4 py-10 text-center text-sm text-muted-foreground" data-testid="pick-employee">
                {employees.length === 0 ? tInq('noEmployees') : tInq('pickEmployeeRecords')}
              </p>
            </Card>
          ) : (
          <Card className="overflow-hidden">
            <TableFullscreen
              title={tInq('employeeLeaveRecord')}
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
                    <th className={th}>{t('filters.employeeId')}</th>
                    {/* fe3eb141 — the short leave reference the Requests subsection shows under its
                        Applied date. It is a working handle: the `q` box above matches a uuid prefix. */}
                    <th className={th}>{t('filters.reference')}</th>
                    {sortableTh('name', t('colEmployee'))}
                    {sortableTh('start', t('filters.dateFrom'))}
                    {sortableTh('end', t('filters.dateTo'))}
                    <th className={th}>{t('colDays')}</th>
                    <th className={th}>{tInq('colLeaveCode')}</th>
                    {sortableTh('status', t('filters.statusLabel'))}
                    <th className={th}>{tInq('colReason')}</th>
                    <th className={th}>{tInq('colAttachment')}</th>
                    {sortableTh('applied', t('colApplied'))}
                    <th className={th}>{tInq('colFinalApproval')}</th>
                    {/* Reporter's placement, verbatim: "on the right side of the Final Approval Date
                        column for each leave record". */}
                    <th className={th}>{t('colAction')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={13} className="px-4 py-6 text-center text-muted-foreground">
                        {tInq('noRecords')}
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-xs text-muted-foreground">{r.employeeCode ?? '—'}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                        #{r.id.slice(0, 8)}
                      </td>
                      <td className="px-2 py-2 font-medium">{r.employee}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted-foreground">{r.startDate}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted-foreground">{r.endDate}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                        {formatDays(r.days)}
                        {durationLabel(t, r.durationType, r.hours) && (
                          <span className="ml-1 text-[10px] font-medium uppercase text-muted-foreground">
                            {durationLabel(t, r.durationType, r.hours)}
                          </span>
                        )}
                        {/* fef49b9a — HR's Employee Leave Record shows the same breakdown as the employee's
                            own history and the approver's list, from the SAME derivation. Four screens
                            doing their own subtraction is how they come to disagree. */}
                        {(() => {
                          const rows = leaveDisplaySplit({
                            leaveTypeName: r.leaveType,
                            days: r.days,
                            unpaidDays: r.unpaidDays,
                            unpaidTypeName,
                            unpaidFallbackLabel: t('unpaidPortionLabel'),
                          });
                          return rows.length > 1 ? (
                            <div className="text-[10px] font-medium text-muted-foreground">
                              {rows.map((row, i) => (
                                <span key={row.label + i}>
                                  {i > 0 && ' · '}
                                  <span className={row.unpaid ? 'text-amber-700 dark:text-amber-400' : undefined}>
                                    {row.label} {formatDays(row.days)}
                                  </span>
                                </span>
                              ))}
                            </div>
                          ) : null;
                        })()}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">{r.typeCode ?? r.leaveType}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${LEAVE_STATUS_PILL[r.status] ?? LEAVE_STATUS_PILL_DEFAULT}`}
                        >
                          {t(`status.${r.status}`)}
                        </span>
                        {/* A pending give-back (ADR-0065) is the one thing that changes what cancelling
                            this record means, so it is shown here exactly as the Requests table shows it. */}
                        {r.pendingCancellationId && (
                          <span className="ml-1.5 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                            {t('cancelPendingBadge')}
                          </span>
                        )}
                        {/* fe3eb141 — the Approval Information lines (0773bda9). This screen already had
                            the Final Approval DATE; the Requests subsection also names WHO decided, and
                            which stage a still-pending record is waiting on. Both are on the row already,
                            so carrying them across costs nothing and closes two more of the gaps between
                            the two tables. */}
                        {r.decidedByName && (
                          <span className="mt-0.5 block text-[10px] text-muted-foreground">
                            {t('filters.decidedByLine', { name: r.decidedByName })}
                          </span>
                        )}
                        {r.status === 'pending' && r.currentStepKind && (
                          <span className="mt-0.5 block text-[10px] text-muted-foreground">
                            {t('filters.pendingWithLine', {
                              stage:
                                r.currentStepKind === 'direct_manager' || r.currentStepKind === 'hr_admin'
                                  ? t(`filters.stage.${r.currentStepKind}`)
                                  : r.currentStepKind,
                            })}
                          </span>
                        )}
                      </td>
                      <td className="max-w-[24rem] truncate px-2 py-2 text-muted-foreground" title={r.reason ?? ''}>
                        {r.reason || '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        {r.hasDocument ? (
                          <Link
                            href={`/me/leave/attachment/${r.id}?inline=1`}
                            className="text-primary hover:underline"
                          >
                            {tInq('viewAttachment')}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted-foreground">{day(r.appliedOn)}</td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted-foreground">{day(r.decidedAt)}</td>
                      {/* fe3eb141 — Cancel Leave, on the right of Final Approval Date. This is
                          `adminCancelLeave`: IMMEDIATE cancellation of someone else's pending OR
                          approved record, which for an approved one REVERSES the net ledger debit and
                          gives the days back. It is deliberately NOT the employee give-back flow
                          (`requestLeaveCancellation`), which needs an approval and only exists for the
                          subject's own leave — an admin on this screen is never the subject, because
                          the service self-bans below super_admin and `canAdminCancelLeave` mirrors it. */}
                      <td className="px-3 py-2">
                        {canAdminCancelLeave(r, session.personId) ? (
                          <AdminCancelLeaveDialog
                            leaveRequestId={r.id}
                            back="/leave/employee-records"
                            backEmp={selected?.employmentId}
                            submitAction={adminCancelLeaveAction}
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
            <Pager
              hrefFor={pagerHref}
              state={pageState(pq, total, rows.length)}
              exportHref={exportHref('csv')}
            />
          </Card>
          )}
        </div>
      </CollapsibleEmployeePanel>
    </div>
  );
}
