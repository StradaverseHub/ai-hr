import Link from 'next/link';
import { companyWorkflowHref, isWorkflowId } from '../navigation';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions, getAttendanceWorkflow, previewAttendanceWorkflow } from '@/packs/attendance/service';
import { PageHeader, Card, pageWideCls } from '@/components/ui';
import { approversOf } from '@/lib/leave-approval-kinds';
export default async function ViewAttendanceWorkflowPage({ params }: {
    params: Promise<{
        lineageId: string;
    }>;
}) {
    const { s, scopeIds } = await scopedAdmin(), { lineageId } = await params, t = await getTranslations('attendanceWorkflow');
    if (!isWorkflowId(lineageId)) notFound();
    const row = await getAttendanceWorkflow(s, lineageId, scopeIds);
    if (!row)
        notFound();
    const options = await attendanceApplicationFilterOptions(s, [row.companyId]), preview = await previewAttendanceWorkflow(s, { ...row, description: row.description ?? '' }, lineageId);
    const fields = [['departmentIds', 'department', options.departments], ['businessUnitIds', 'businessUnit', options.businessUnits], ['gradeIds', 'grade', options.grades], ['orgDivision', 'division', options.divisions]] as const;
    return <div className={pageWideCls}><PageHeader title={row.name} description={t('version', { number: row.version })} back={{ href: companyWorkflowHref(row.companyId, row.applicationType), label: t('back') }} actions={<Link className="text-primary underline" href={`/admin/attendance/approval-workflow/${lineageId}/edit`}>{t('edit')}</Link>}/><Card className="space-y-3 p-5"><p>{t('code')}: {row.code}</p><p>{t('company')}: {options.companies.find(c => c.id === row.companyId)?.name}</p><p>{t('applicationType')}: {t(`types.${row.applicationType}`)}</p><p>{t('priority')}: {row.priority}</p><p>{t('status')}: {row.active ? t('active') : t('inactive')}</p>{row.description && <p>{row.description}</p>}{fields.map(([key, label, items]) => <p key={key}>{t(label)}: {row.criteria[key]?.length ? row.criteria[key]!.map(id => items.find(x => x.id === id)?.name ?? t('unavailable', { value: id })).join(', ') : t('all')}</p>)}</Card><Card className="space-y-3 p-5"><h2 className="font-semibold">{t('stages')}</h2><ol className="list-inside list-decimal space-y-3">{row.stages.map((stage, i) => <li key={i}>{stage.name} — {approversOf(stage.level).map(a => a.kind === 'direct_manager' ? t('manager') : t('hr')).join(` ${t('or')} `)}</li>)}</ol><p className="text-sm text-muted-foreground">{t('supportedApprovers')}</p><p className="text-sm text-muted-foreground">{t('alternativeHelp')}</p></Card><Card className="space-y-3 p-5"><h2 className="font-semibold">{t('previewTitle', { count: preview.total })}</h2><ul className="divide-y divide-border">{preview.rows.map(item => <li className="py-2" key={item.employmentId}>{item.name} — {item.selectedCode}{item.problem && <p className="text-red-700">{item.problem}</p>}</li>)}</ul>{preview.truncated && <p>{t('previewTruncated')}</p>}</Card></div>;
}
