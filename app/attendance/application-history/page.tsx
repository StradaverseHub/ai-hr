import { cookies } from 'next/headers';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AttendanceHistoryFilters } from '@/components/attendance-history-filters';
import { AttendanceHistoryTable } from '@/components/attendance-history-table';
import { attendanceHistoryReturn } from '@/lib/attendance-history-filter';
import { publicErrorMessage } from '@/lib/public-error';
import { scopedAdmin } from '@/lib/scope';
import { listAttendanceApplicationHistory, attendanceApplicationFilterOptions, type AttendanceHistoryFilter } from '@/packs/attendance/service';
import { PageHeader, Card, ErrorBanner, pageWideCls, inputCls } from '@/components/ui';

export default async function AttendanceApplicationHistoryPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { s, scopeIds } = await scopedAdmin(), sp = await searchParams, t = await getTranslations('attendanceHistory');
  const status = (sp.status || 'pending') as AttendanceHistoryFilter['status'];
  const f: AttendanceHistoryFilter = {
    employmentId: sp.employmentId, requestKind: sp.requestKind as AttendanceHistoryFilter['requestKind'],
    attendanceFrom: sp.attendanceFrom, attendanceTo: sp.attendanceTo, companyId: sp.companyId,
    departmentId: sp.departmentId, businessUnitId: sp.businessUnitId, gradeId: sp.gradeId, division: sp.division,
    applicationType: sp.applicationType as AttendanceHistoryFilter['applicationType'], status,
    submittedFrom: sp.submittedFrom, submittedTo: sp.submittedTo, query: sp.query,
    page: Number(sp.page ?? 1), pageSize: Number(sp.pageSize ?? 25),
  };
  const emptyCounts = { pending: 0, approved: 0, rejected: 0, cancelled: 0, withdrawn: 0, cancelledWithdrawn: 0, all: 0 };
  const [result, options] = await Promise.all([
    listAttendanceApplicationHistory(s, scopeIds, f).then(data => ({ data, error: null as string | null })).catch(e => ({ data: { rows: [], total: 0, counts: emptyCounts, page: 1, pageSize: 25 }, error: publicErrorMessage(e) })),
    attendanceApplicationFilterOptions(s, scopeIds),
  ]);
  const { data, error } = result;
  const url = (page: number, nextStatus = status) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(sp)) if (value && key !== 'page' && key !== 'status') query.set(key, value);
    if (nextStatus) query.set('status', nextStatus);
    query.set('page', String(page));
    return '/attendance/application-history?' + query;
  };
  const selects = [['companyId', 'company', options.companies], ['departmentId', 'department', options.departments], ['businessUnitId', 'businessUnit', options.businessUnits], ['gradeId', 'grade', options.grades], ['division', 'division', options.divisions]] as const;
  const fieldClass = 'block space-y-1 rounded-md bg-white! p-2 text-sm text-slate-900!';
  const controlClass = `${inputCls} min-h-11 w-full bg-white! text-slate-900! caret-slate-900! [color-scheme:light]`;
  const panel = <Card className="space-y-3 p-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <label className={fieldClass}>{t('search')}<input name="query" className={controlClass} defaultValue={sp.query} /></label>
    {selects.map(([key, label, items]) => <label className={fieldClass} key={key}>{t(label)}<select name={key} defaultValue={sp[key] ?? ''} className={controlClass}><option value="">{t('all')}</option>{items.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>)}
    <label className={fieldClass}>{t('applicationType')}<select name="applicationType" defaultValue={sp.applicationType ?? ''} className={controlClass}><option value="">{t('all')}</option><option value="irregularity">{t('types.irregularity')}</option><option value="self_overtime">{t('types.self_overtime')}</option></select></label>
    <label className={fieldClass}>{t('subtype')}<select name="requestKind" defaultValue={sp.requestKind ?? ''} className={controlClass}><option value="">{t('all')}</option>{['absent', 'short_hours', 'incomplete_entry', 'self_overtime', 'other', 'unknown'].map(k => <option key={k} value={k}>{t(`subtypes.${k}`)}</option>)}</select></label>
    {(['attendanceFrom', 'attendanceTo', 'submittedFrom', 'submittedTo'] as const).map(key => <label key={key} className={fieldClass}>{t(key)}<input type="date" name={key} className={controlClass} defaultValue={sp[key]} /></label>)}
    <label className={fieldClass}>{t('status')}<select name="status" defaultValue={status} className={controlClass}><option value="all">{t('all')}</option>{['pending', 'approved', 'rejected', 'cancelled', 'withdrawn'].map(value => <option key={value} value={value}>{t(`statuses.${value}`)}</option>)}<option value="cancelled_withdrawn">{t('cancelledWithdrawn')}</option></select></label>
    <label className={fieldClass}>{t('pageSize')}<select name="pageSize" className={controlClass} defaultValue={sp.pageSize ?? '25'}>{[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
  </div><p className="text-xs text-muted-foreground">{t('organisationHelp')}</p></Card>;
  const selection = <label className={`${fieldClass} max-w-2xl`}>{t('selectEmployeeLabel')}<select name="employmentId" defaultValue={sp.employmentId ?? ''} className={controlClass}><option value="">{t('allEmployees')}</option>{options.employees.map(e => <option key={e.id} value={e.id}>{e.employeeCode ? `${e.employeeCode} · ` : ''}{e.name}</option>)}</select></label>;
  const tabs = [
    ['pending', t('statuses.pending'), data.counts.pending], ['approved', t('statuses.approved'), data.counts.approved],
    ['rejected', t('statuses.rejected'), data.counts.rejected], ['cancelled_withdrawn', t('cancelledWithdrawn'), data.counts.cancelledWithdrawn],
    ['all', t('all'), data.counts.all],
  ] as const;
  const returnTo = attendanceHistoryReturn(url(data.page));
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={t('subtitle')} /><ErrorBanner message={error ?? undefined} />
    <AttendanceHistoryFilters selection={selection} panel={panel} defaultOpen={(await cookies()).get('attendance-history-panel')?.value === '1'}>
      <div className="space-y-4">
        <nav aria-label={t('statusNavigation')} className="flex flex-wrap gap-x-5 border-b border-border">
          {tabs.map(([value, label, count]) => {
            const active = status === value || value === 'cancelled_withdrawn' && (status === 'cancelled' || status === 'withdrawn');
            return <Link key={value} href={url(1, value)} aria-label={`${label} ${count}`} aria-current={active ? 'page' : undefined} className={`inline-flex min-h-11 items-center gap-2 border-b-2 px-1 text-sm ${active ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}><span>{label}{' '}</span><span className="tabular-nums">{count}</span></Link>;
          })}
        </nav>
        <AttendanceHistoryTable key={returnTo} rows={data.rows} returnTo={returnTo} />
        <div className="flex flex-wrap justify-between gap-4 text-sm"><p>{t('total', { count: data.total })}</p><nav aria-label={t('pagination')} className="flex items-center gap-4">{data.page > 1 && <Link className="inline-flex min-h-11 items-center text-primary underline" href={url(data.page - 1)}>{t('previous')}</Link>}<span>{t('page', { number: data.page })}</span>{data.page * data.pageSize < data.total && <Link className="inline-flex min-h-11 items-center text-primary underline" href={url(data.page + 1)}>{t('next')}</Link>}</nav></div>
      </div>
    </AttendanceHistoryFilters>
  </div>;
}
