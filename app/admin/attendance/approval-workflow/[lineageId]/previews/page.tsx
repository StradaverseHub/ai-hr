import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions, getAttendanceWorkflow, getAttendanceWorkflowPreview, listAttendanceWorkflowPreviews } from '@/packs/attendance/service';
import { Card, PageHeader, pageWideCls, tableWrapCls, tbodyCls, thCls } from '@/components/ui';
import { attendancePreviewWarningKey, type AttendancePreviewApproverSource, type AttendanceWorkflowPreviewEmployee } from '@/lib/attendance-workflow-preview';
import { GeneratePreviewButton } from '../../generate-preview-button';
import { isWorkflowId, previewHistoryHref, workflowRoot } from '../../navigation';
/** Preview History: stored Preview Assignment snapshots. Administrator of every workflow company only (service + RLS). */
export default async function AttendanceWorkflowPreviewHistoryPage({ params, searchParams }: { params: Promise<{ lineageId: string }>; searchParams?: Promise<{ id?: string | string[] }> }) {
  const { s, scopeIds, allowedCompanyIds } = await scopedAdmin(), { lineageId } = await params, query = (await searchParams) ?? {};
  if (!isWorkflowId(lineageId) || (query.id !== undefined && (typeof query.id !== 'string' || !isWorkflowId(query.id)))) notFound();
  const scope = allowedCompanyIds ?? scopeIds;
  const row = await getAttendanceWorkflow(s, lineageId, scope, true);
  if (!row) notFound();
  const [history, preview] = await Promise.all([listAttendanceWorkflowPreviews(s, lineageId, scope), getAttendanceWorkflowPreview(s, lineageId, scope, query.id)]);
  if (query.id && !preview) notFound();
  const [t, p, v3, v4, format] = await Promise.all([getTranslations('attendanceWorkflow'), getTranslations('attendanceWorkflow.previewHistory'), getTranslations('attendanceWorkflow.v3'), getTranslations('attendanceWorkflow.v4'), getFormatter()]);
  const options = preview ? await attendanceApplicationFilterOptions(s, preview.companyIds) : null;
  const when = (value: Date) => format.dateTime(value, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });
  const sourceLabel = (source: AttendancePreviewApproverSource | null) => !source ? '—' : source.kind === 'direct_manager' ? v3('depthOption', { number: source.depth }) : source.kind === 'specific_employee' ? v3('selectedEmployees') : source.kind === 'hr_admin' ? t('hr') : v4('cc');
  const person = (name: string | null, code: string | null) => [name, code].filter(Boolean).join(' · ');
  const levelCount = Math.max(1, ...(preview?.employees ?? []).map(employee => employee.levels.length));
  const cell = (employee: AttendanceWorkflowPreviewEmployee, index: number) => {
    if (employee.outcome === 'warning') return index === 0 ? <span className="text-destructive">{p('seeWarning')}</span> : '—';
    if (employee.outcome === 'otherWorkflow') return index === 0 ? p('otherWorkflow', { code: employee.selectedCode }) : '—';
    if (employee.outcome === 'tie') return index === 0 ? <span className="text-destructive">{p('seeWarning')}</span> : '—';
    const level = employee.levels[index];
    if (!level) return '—';
    if (level.state === 'skipped') return <span className="italic text-muted-foreground">{p('notRequired')}</span>;
    return level.approvers.map(actor => actor.kind === 'hr_admin' ? t('hr') : person(actor.name, actor.employeeCode)).join(' / ');
  };
  return <div className={pageWideCls + ' space-y-5'}>
    <PageHeader title={p('title')} description={`${row.code} · ${row.name} · ${t(`types.${row.applicationType}`)}`} back={{ href: `${workflowRoot}/${lineageId}`, label: p('backToWorkflow') }}/>
    {preview && preview.templateVersion < row.version && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">{p('olderVersion', { previewVersion: preview.templateVersion, currentVersion: row.version })}</p>}
    {!row.retiredAt && <GeneratePreviewButton lineageId={lineageId} version={row.version}/>}
    {!preview ? <Card className="p-5"><p className="text-sm text-muted-foreground">{p('none')}</p></Card> : <>
      <Card className="space-y-4 p-5">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{([
          ['generatedAt', when(preview.generatedAt)], ['generatedBy', preview.generatedBy ?? '—'], ['workflowVersion', String(preview.templateVersion)],
          ['matching', String(preview.totalMatching)], ['warnings', String(preview.warningCount)],
        ] as const).map(([key, value]) => <div key={key} className="rounded-lg bg-muted p-3"><dt className="text-xs text-muted-foreground">{p(`stats.${key}`)}</dt><dd className="font-semibold">{value}</dd></div>)}</dl>
        {history && history.length > 1 && <nav aria-label={p('earlier')} className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">{p('earlier')}:</span>{history.map(item => <Link key={item.id} href={previewHistoryHref(lineageId, item.id)} aria-current={item.id === preview.id ? 'page' : undefined} className={'rounded-full border px-3 py-1 ' + (item.id === preview.id ? 'border-primary font-semibold text-primary' : 'border-border')}>{p('chip', { date: when(item.generatedAt), version: item.templateVersion })}</Link>)}</nav>}
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">{p('warningsTitle', { count: preview.warningCount })}</h2>
        {preview.warnings.length ? <div className={tableWrapCls}><table className="w-full text-left text-sm"><thead><tr>{['employeeId', 'employeeName', 'approvalLevel'].map(key => <th key={key} className={thCls}>{t(key)}</th>)}<th className={thCls}>{p('approverSource')}</th><th className={thCls}>{p('warning')}</th></tr></thead><tbody className={tbodyCls}>{preview.warnings.map((warning, index) => <tr key={index}>
          <td className="p-3">{warning.employeeCode ?? '—'}</td><td className="p-3">{warning.name}</td>
          <td className="p-3">{warning.levelIndex === null ? '—' : t('stageNumber', { number: warning.levelIndex + 1 })}</td>
          <td className="p-3">{sourceLabel(warning.source)}{(warning.approverName || warning.approverCode) && `: ${person(warning.approverName, warning.approverCode)}`}</td>
          <td className="p-3 text-destructive">{p(`problems.${attendancePreviewWarningKey(warning)}`)}{warning.superiorDepth !== null && <span className="block text-xs text-muted-foreground">{p('stoppedAt', { level: v3('depthOption', { number: warning.superiorDepth }) })}</span>}</td>
        </tr>)}</tbody></table></div> : <p className="text-sm text-muted-foreground">{p('noWarnings')}</p>}
        {preview.warningCount > preview.warnings.length && <p className="text-sm">{p('warningsTruncated', { shown: preview.warnings.length, total: preview.warningCount })}</p>}
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">{p('employeesTitle', { count: preview.totalMatching })}</h2>
        {preview.employees.length ? <div className={tableWrapCls}><table className="w-full text-left text-sm"><thead><tr>{['employeeId', 'employeeName', 'company'].map(key => <th key={key} className={thCls}>{t(key)}</th>)}{Array.from({ length: levelCount }, (_, index) => <th key={index} className={thCls}>{t('stageNumber', { number: index + 1 })}</th>)}</tr></thead><tbody className={tbodyCls}>{preview.employees.map(employee => <tr key={employee.companyId + employee.employmentId}>
          <td className="p-3">{employee.employeeCode ?? '—'}</td><td className="p-3">{employee.name}</td>
          <td className="p-3">{options?.companies.find(company => company.id === employee.companyId)?.name ?? '—'}</td>
          {Array.from({ length: levelCount }, (_, index) => <td key={index} className="p-3">{cell(employee, index)}</td>)}
        </tr>)}</tbody></table></div> : <p className="text-sm text-muted-foreground">{p('noEmployees')}</p>}
        {preview.totalMatching > preview.employees.length && <p className="text-sm">{p('employeesTruncated', { shown: preview.employees.length, total: preview.totalMatching })}</p>}
      </Card>
    </>}
  </div>;
}
