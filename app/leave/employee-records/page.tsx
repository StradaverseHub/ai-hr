import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees, listLeaveRequestsPage, listLeaveTypes } from '@/core/read';
import { Button, Card, PageHeader, inputCls } from '@/components/ui';
import { FilterChips, FilterPanel, type FilterField } from '@/components/filter-panel';
import { LeaveInquiryNav } from '@/components/leave/leave-inquiry-nav';
import { pickInquiryEmployee, sortInquiryEmployees } from '@/lib/leave-inquiry';
import { durationLabel } from '@/lib/leave-duration';

/**
 * Employee Leave Record (feedback 953be4b0) — the transactions behind a balance: every leave request for
 * one employee, opened by clicking a leave row on Employee Balances.
 *
 * Reads the existing leave-request projection (`listLeaveRequestsPage`) narrowed to (employment, leave
 * type) rather than deriving a second history, so this page, the admin history table on /leave and the
 * approvals inbox always describe the same records. Attachments link to the SAME per-request route the
 * employee's own page uses, whose authorization is unchanged — being able to read a leave record here does
 * not by itself grant the document behind it.
 */

const PAGE = 25;
const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

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
  }>;
}) {
  const { s: session, scopeIds } = await scopedAdmin();
  const t = await getTranslations('leave');
  const tInq = await getTranslations('leave.inquiry');
  const locale = await getLocale();
  const sp = await searchParams;
  const arr = (v?: string | string[]): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

  const employees = sortInquiryEmployees(await listEmployees(session, scopeIds), locale);
  const selected = pickInquiryEmployee(employees, sp.emp);

  const typeIds = arr(sp.type);
  const statuses = arr(sp.status).filter((s) => (LEAVE_STATUSES as readonly string[]).includes(s));
  const q = sp.q?.trim() || undefined;
  const from = sp.from || undefined;
  const to = sp.to || undefined;
  // Default order is newest REQUEST first — `applied` desc is exactly that (leave_request.created_at).
  const sort = sp.sort || 'applied';
  const dir: 'asc' | 'desc' = sp.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(0, Number(sp.page) || 0);

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
          limit: PAGE,
          offset: page * PAGE,
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
    p.set('sort', key);
    p.set('dir', sort === key && dir === 'asc' ? 'desc' : 'asc');
    return `/leave/employee-records?${p.toString()}`;
  };
  const pageHref = (n: number) => {
    const p = withSort(params());
    if (n > 0) p.set('page', String(n));
    return `/leave/employee-records?${p.toString()}`;
  };
  const exportHref = (format: 'csv' | 'xlsx') => {
    const p = withSort(params());
    p.set('format', format);
    return `/leave/employee-records/export?${p.toString()}`;
  };

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

  const th = 'px-3 py-2 font-medium';
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
  const day = (v: Date | string | null) => (v ? new Date(v).toISOString().slice(0, 10) : '—');

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader title={tInq('recordsTitle')} description={tInq('recordsDescription')} />
      <div className="flex flex-col gap-6 sm:flex-row">
        <LeaveInquiryNav active="records" employmentId={selected?.employmentId} />
        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <form method="get" action="/leave/employee-records" className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {tInq('employee')}
              <select name="emp" defaultValue={selected?.employmentId ?? ''} className={`${inputCls} w-72`}>
                {employees.map((e) => (
                  <option key={e.employmentId} value={e.employmentId}>
                    {e.company} · {e.name}
                    {e.employeeCode ? ` (${e.employeeCode})` : ''}
                  </option>
                ))}
              </select>
            </label>
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
              <span className="ml-2 font-normal text-muted-foreground">
                {t('requestsCountTotal', { count: total })}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className={th}>{t('filters.employeeId')}</th>
                    {sortableTh('name', t('colEmployee'))}
                    {sortableTh('start', t('filters.dateFrom'))}
                    {sortableTh('end', t('filters.dateTo'))}
                    <th className={th}>{t('colDays')}</th>
                    <th className={th}>{tInq('colLeaveCode')}</th>
                    <th className={th}>{tInq('colReason')}</th>
                    <th className={th}>{tInq('colAttachment')}</th>
                    {sortableTh('applied', t('colApplied'))}
                    <th className={th}>{tInq('colFinalApproval')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-4 py-6 text-center text-muted-foreground">
                        {tInq('noRecords')}
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.employeeCode ?? '—'}</td>
                      <td className="px-3 py-2 font-medium">{r.employee}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.startDate}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.endDate}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {Number(r.days)}
                        {durationLabel(t, r.durationType, r.hours) && (
                          <span className="ml-1 text-[10px] font-medium uppercase text-muted-foreground">
                            {durationLabel(t, r.durationType, r.hours)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.typeCode ?? r.leaveType}</td>
                      <td className="max-w-[16rem] truncate px-3 py-2 text-muted-foreground" title={r.reason ?? ''}>
                        {r.reason || '—'}
                      </td>
                      <td className="px-3 py-2">
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
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{day(r.appliedOn)}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{day(r.decidedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(page > 0 || (page + 1) * PAGE < total) && (
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                <span>
                  {t('filters.rangeOf', {
                    from: total === 0 ? 0 : page * PAGE + 1,
                    to: Math.min((page + 1) * PAGE, total),
                    total,
                  })}
                </span>
                <span className="flex gap-2">
                  {page > 0 && (
                    <Link href={pageHref(page - 1)} className="hover:text-foreground">
                      {t('filters.newer')}
                    </Link>
                  )}
                  {(page + 1) * PAGE < total && (
                    <Link href={pageHref(page + 1)} className="hover:text-foreground">
                      {t('filters.older')}
                    </Link>
                  )}
                </span>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
