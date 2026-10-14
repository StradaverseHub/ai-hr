import { cookies } from 'next/headers';
import { AttendanceHistoryFilters } from '@/components/attendance-history-filters';
import { AttendanceHistoryTable } from '@/components/attendance-history-table';
import { attendanceHistoryReturn } from '@/lib/attendance-history-filter';
import Link from 'next/link';
import { publicErrorMessage } from '@/lib/public-error';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listAttendanceApplicationHistory, attendanceApplicationFilterOptions, type AttendanceHistoryFilter } from '@/packs/attendance/service';
import { PageHeader, Card, ErrorBanner, pageWideCls, inputCls, tableWrapCls, theadCls, tbodyCls, thCls, Button } from '@/components/ui';
export default async function AttendanceApplicationHistoryPage({ searchParams }: {
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    const { s, scopeIds } = await scopedAdmin(), sp = await searchParams, t = await getTranslations('attendanceHistory'), locale = await getLocale();
    const f: AttendanceHistoryFilter = { employmentId:sp.employmentId,requestKind:sp.requestKind as AttendanceHistoryFilter['requestKind'],attendanceFrom:sp.attendanceFrom,attendanceTo:sp.attendanceTo, companyId: sp.companyId, departmentId: sp.departmentId, businessUnitId: sp.businessUnitId, gradeId: sp.gradeId, division: sp.division, applicationType: sp.applicationType as AttendanceHistoryFilter['applicationType'], status: sp.status as AttendanceHistoryFilter['status'], submittedFrom: sp.submittedFrom, submittedTo: sp.submittedTo, query: sp.query, page: Number(sp.page ?? 1), pageSize: Number(sp.pageSize ?? 25) };
    const [result, options] = await Promise.all([listAttendanceApplicationHistory(s, scopeIds, f).then(data => ({ data, error: null as string | null })).catch(e => ({ data: { rows: [], total: 0, page: 1, pageSize: 25 }, error: publicErrorMessage(e) })), attendanceApplicationFilterOptions(s, scopeIds)]);
    const { data, error } = result;
    const selects = [['employmentId','employee',options.employees],['companyId', 'company', options.companies], ['departmentId', 'department', options.departments], ['businessUnitId', 'businessUnit', options.businessUnits], ['gradeId', 'grade', options.grades], ['division', 'division', options.divisions]] as const;
    const url = (page: number) => {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(sp))
            if (v && k !== 'page')
                q.set(k, v);
        q.set('page', String(page));
        return '/attendance/application-history?' + q.toString();
    };
    const panel=<Card className="p-5"><form className="grid gap-3 [&_label]:rounded [&_label]:bg-white [&_label]:p-2 [&_label]:text-sm [&_label]:text-slate-900 [&_input]:text-foreground [&_select]:text-foreground"><label>{t('search')}<input name="query" className={inputCls} defaultValue={sp.query}/></label>{selects.map(([key, label, items]) => <label key={key}>{t(label)}<select name={key} defaultValue={sp[key] ?? ''} className={inputCls}><option value="">{t('all')}</option>{items.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>)}<label>{t('applicationType')}<select name="applicationType" defaultValue={sp.applicationType ?? ''} className={inputCls}><option value="">{t('all')}</option><option value="irregularity">{t('types.irregularity')}</option><option value="self_overtime">{t('types.self_overtime')}</option></select></label><label>{t('subtype')}<select name="requestKind" defaultValue={sp.requestKind??''} className={inputCls}><option value="">{t('all')}</option>{['absent','short_hours','incomplete_entry','self_overtime','other','unknown'].map(k=><option key={k} value={k}>{t(`subtypes.${k}`)}</option>)}</select></label><label>{t('attendanceFrom')}<input type="date" name="attendanceFrom" className={inputCls} defaultValue={sp.attendanceFrom}/></label><label>{t('attendanceTo')}<input type="date" name="attendanceTo" className={inputCls} defaultValue={sp.attendanceTo}/></label><label>{t('status')}<select name="status" defaultValue={sp.status ?? ''} className={inputCls}><option value="">{t('all')}</option>{['pending', 'approved', 'rejected', 'cancelled', 'withdrawn'].map(v => <option key={v} value={v}>{t(`statuses.${v}`)}</option>)}</select></label><label>{t('submittedFrom')}<input type="date" name="submittedFrom" className={inputCls} defaultValue={sp.submittedFrom}/></label><label>{t('submittedTo')}<input type="date" name="submittedTo" className={inputCls} defaultValue={sp.submittedTo}/></label><label>{t('pageSize')}<select name="pageSize" className={inputCls} defaultValue={sp.pageSize ?? '25'}>{[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}</select></label><div className="flex items-end gap-3"><Button type="submit">{t('filter')}</Button><Link href="/attendance/application-history" className="text-primary underline">{t('clear')}</Link></div></form><p className="mt-3 text-xs text-muted-foreground">{t('organisationHelp')}</p></Card>;
    const returnTo=attendanceHistoryReturn(url(data.page));
    const defaultOpen=(await cookies()).get('attendance-history-panel')?.value!=='0';
    return <div className={pageWideCls}><PageHeader title={t('title')} description={t('subtitle')}/><ErrorBanner message={error??undefined}/><AttendanceHistoryFilters panel={panel} defaultOpen={defaultOpen}><div className="min-w-0 space-y-4"><AttendanceHistoryTable key={returnTo} rows={data.rows} returnTo={returnTo}/><div className="flex flex-wrap justify-between gap-4 text-sm"><p>{t('total', { count: data.total })}</p><nav aria-label={t('pagination')} className="flex gap-4">{data.page > 1 && <Link href={url(data.page - 1)}>{t('previous')}</Link>}<span>{t('page', { number: data.page })}</span>{data.page * data.pageSize < data.total && <Link href={url(data.page + 1)}>{t('next')}</Link>}</nav></div></div></AttendanceHistoryFilters></div>;
}
