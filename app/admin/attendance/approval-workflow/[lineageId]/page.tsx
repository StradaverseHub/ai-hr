import Link from 'next/link';
import {WorkflowRetirementControls} from '../retirement-controls';
import {attendanceWorkflowConfiguration} from '@/lib/attendance-workflow-config';
import { AttendanceWorkflowStageDescription } from '@/components/attendance-workflow-stage-description';
import { attendanceLevelProblemMessageKey } from '@/lib/attendance-workflow-v3';
import { AttendanceResolvedRoutePreview } from '@/components/attendance-resolved-route-preview';
import { companyWorkflowHref, isWorkflowId } from '../navigation';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions, getAttendanceWorkflow, previewAttendanceWorkflow } from '@/packs/attendance/service';
import { PageHeader, Card, pageWideCls } from '@/components/ui';
import { attendanceWorkflowCriteriaFields } from '@/lib/attendance-workflow';
import { approversOf } from '@/lib/leave-approval-kinds';
export default async function ViewAttendanceWorkflowPage({ params }: {
    params: Promise<{
        lineageId: string;
    }>;
}) {
    const { s, scopeIds } = await scopedAdmin(), { lineageId } = await params, t = await getTranslations('attendanceWorkflow');
    if (!isWorkflowId(lineageId)) notFound();
    const row = await getAttendanceWorkflow(s, lineageId, scopeIds,true);
    if (!row)
        notFound();
    const options = await attendanceApplicationFilterOptions(s, [row.companyId]), preview = row.retiredAt?{total:0,rows:[],truncated:false}:await previewAttendanceWorkflow(s, attendanceWorkflowConfiguration(row), lineageId);
    const employmentTypeLabel = await getTranslations('people.wizard.employmentType');
  const fields = attendanceWorkflowCriteriaFields(options, employmentTypeLabel);
    return <div className={pageWideCls}><PageHeader title={row.name} description={t('version', { number: row.version })} back={{ href: companyWorkflowHref(row.companyId, row.applicationType), label: t('back') }} actions={<div className="flex flex-wrap gap-3">{!row.retiredAt&&<Link className="text-primary underline" href={`/admin/attendance/approval-workflow/${lineageId}/edit`}>{t('edit')}</Link>}<WorkflowRetirementControls retired={!!row.retiredAt} lineageId={lineageId} version={row.version} name={row.name} company={options.companies.find(c=>c.id===row.companyId)?.name??''}/></div>}/><Card className="space-y-3 p-5"><p>{t('code')}: {row.code}</p><p>{t('company')}: {options.companies.find(c => c.id === row.companyId)?.name}</p><p>{t('applicationType')}: {t(`types.${row.applicationType}`)}</p><p>{t('priority')}: {row.priority}</p><p>{t('status')}: {row.retiredAt?t('v4.deleted'):row.active ? t('active') : t('inactive')}</p>{row.description && <p>{row.description}</p>}{fields.map(({key, label, options:items}) => <p key={key}>{t(label)}: {row.criteria[key]?.length ? row.criteria[key]!.map(id => items.find(x => x.id === id)?.name ?? t('unavailable', { value: id })).join(', ') : t('all')}</p>)}</Card><Card className="space-y-3 p-5"><h2 className="font-semibold">{t('stages')}</h2><ol className="list-inside list-decimal space-y-3">{row.stages.map((stage, i) => <li key={i}>{row.routingVersion !== 1 ? t('stageNumber', { number: i + 1 }) : stage.name} — <AttendanceWorkflowStageDescription stage={stage} manager={t('manager')} hr={t('hr')} or={t('or')} sequential={t('v3.sequential')} anyOne={t('v3.anyOne')} allRequired={t('v4.allRequired')} depth={number => t('v3.depthOption', { number })} selectedName={id => { const employee = (options.approverEmployees ?? options.employees).find(row => row.id === id); return employee ? [employee.employeeCode, employee.name].filter(Boolean).join(' · ') : t('unavailable', { value: id }); }}/></li>)}</ol><p className="text-sm text-muted-foreground">{t(row.routingVersion === 3 || row.routingVersion === 4 ? 'v3.levelHelp' : 'supportedApprovers')}</p><p className="text-sm text-muted-foreground">{t(row.routingVersion === 3 || row.routingVersion === 4 ? 'v4.conversionHelp' : 'alternativeHelp')}</p></Card><Card className="space-y-3 p-5"><h2 className="font-semibold">{t('previewTitle', { count: preview.total })}</h2><ul className="divide-y divide-border">{preview.rows.map(item => <li className="py-2" key={item.employmentId}>{item.name} — {item.selectedCode}{item.problem && <p className="text-red-700">{item.problem}</p>}{item.levelProblem && <p className="text-destructive">{item.levelProblem.levelIndex == null ? '' : `${t('stageNumber', { number: item.levelProblem.levelIndex + 1 })}: `}{t(`v3.${attendanceLevelProblemMessageKey(item.levelProblem)}`)}</p>}<AttendanceResolvedRoutePreview stages={item.resolvedStages ?? []} routingVersion={item.routingVersion ?? 1} levelName={number => t('stageNumber', { number })} hrLabel={t('hr')} alternativeLabel={t('or')} sequentialLabel={t('v3.sequential')} anyOneLabel={t('v3.anyOne')} allRequiredLabel={t('v4.allRequired')} depthLabel={number => t('v3.depthOption', { number })}/></li>)}</ul>{preview.truncated && <p>{t('previewTruncated')}</p>}</Card></div>;
}
