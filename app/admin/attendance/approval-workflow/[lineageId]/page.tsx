import Link from 'next/link';
import {GeneratePreviewButton} from '../generate-preview-button';
import {WorkflowRetirementControls} from '../retirement-controls';
import {attendanceWorkflowSelectedEmployees} from '@/lib/attendance-workflow-config';
import { AttendanceWorkflowStageDescription } from '@/components/attendance-workflow-stage-description';
import { companyWorkflowHref, copyWorkflowHref, isWorkflowId, previewHistoryHref } from '../navigation';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions, getAttendanceWorkflow, getAttendanceWorkflowPreview } from '@/packs/attendance/service';
import { PageHeader, Card, pageWideCls } from '@/components/ui';
import { attendanceCriteriaGroups, attendanceWorkflowCriteriaFields } from '@/lib/attendance-workflow';
import { approversOf } from '@/lib/leave-approval-kinds';
export default async function ViewAttendanceWorkflowPage({ params,searchParams }: {
    searchParams?:Promise<{notice?:string}>;
    params: Promise<{
        lineageId: string;
    }>;
}) {
    const { s, scopeIds,allowedCompanyIds } = await scopedAdmin(), { lineageId } = await params, t = await getTranslations('attendanceWorkflow');
    if (!isWorkflowId(lineageId)) notFound();
    const row = await getAttendanceWorkflow(s, lineageId, allowedCompanyIds??scopeIds,true);
    if (!row)
        notFound();
    // Opening the page never recalculates routes: it shows the latest stored Preview Assignment.
    const [options, latest] = await Promise.all([attendanceApplicationFilterOptions(s, row.companyIds??[row.companyId],attendanceWorkflowSelectedEmployees(row.stages)), getAttendanceWorkflowPreview(s, lineageId, allowedCompanyIds??scopeIds)]);
    const p = await getTranslations('attendanceWorkflow.previewHistory'), g = await getTranslations('attendanceWorkflow.groups');
    const notice=(await searchParams)?.notice;
    const [employmentTypeLabel,format] = await Promise.all([getTranslations('people.wizard.employmentType'),getFormatter()]);
    const savedAt = row.createdAt ? format.dateTime(row.createdAt,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}) : null;
  const fields = attendanceWorkflowCriteriaFields(options, employmentTypeLabel), groups = attendanceCriteriaGroups(row.criteria);
  const fieldText = (group: typeof groups[number], key: typeof fields[number]['key'], items: typeof fields[number]['options']) => group[key]?.length ? group[key]!.map(id => items.find(x => x.id === id)?.name ?? t('unavailable', { value: id })).join(', ') : t('all');
  const generatedAt = latest ? format.dateTime(latest.generatedAt,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}) : null;

    return <div className={pageWideCls}><PageHeader title={row.name} description={t('version', { number: row.version })} back={{ href: companyWorkflowHref(row.companyId, row.applicationType), label: t('back') }} actions={<div className="flex flex-wrap gap-3">{!row.retiredAt&&<Link className="text-primary underline" href={`/admin/attendance/approval-workflow/${lineageId}/edit`}>{t('edit')}</Link>}{!row.retiredAt&&<Link className="text-primary underline" href={copyWorkflowHref(lineageId, row.applicationType)}>{t('copy.action')}</Link>}<Link className="text-primary underline" href={previewHistoryHref(lineageId)}>{t('previewHistory.action')}</Link><WorkflowRetirementControls retired={!!row.retiredAt} used={row.used} lineageId={lineageId} version={row.version} name={row.name} company={(row.companyIds??[row.companyId]).map(id=>options.companies.find(c=>c.id===id)?.name??'').join(', ')}/></div>}/><Card className="space-y-3 p-5"><p>{t('code')}: {row.code}</p><p>{t('company')}: {row.allCompanies?t('allCompany'):(row.companyIds??[row.companyId]).map(id=>options.companies.find(c=>c.id===id)?.name).filter(Boolean).join(', ')}</p><p>{t('applicationType')}: {t(`types.${row.applicationType}`)}</p><p>{t('priority')}: {row.priority}</p>{savedAt&&<p>{t('savedAt',{date:savedAt})}</p>}<p>{t('status')}: {row.retiredAt?t('v4.archived'):row.active ? t('active') : t('inactive')}</p>{row.description && <p>{row.description}</p>}{groups.length === 1 ? fields.map(({key, label, options:items}) => <p key={key}>{t(label)}: {fieldText(groups[0], key, items)}</p>) : <div className="space-y-3"><p className="text-sm text-muted-foreground">{g('help')}</p>{groups.map((group, index) => <div key={index} className="space-y-1">{index > 0 && <p className="text-xs font-semibold uppercase text-primary">{g('or')}</p>}<div className="rounded-lg border border-border p-3"><h3 className="font-medium">{g('groupNumber', { number: index + 1 })}</h3>{fields.filter(({key}) => group[key]?.length).map(({key, label, options:items}) => <p key={key}>{t(label)}: {fieldText(group, key, items)}</p>)}{!fields.some(({key}) => group[key]?.length) && <p>{g('everyone')}</p>}</div></div>)}</div>}</Card><Card className="space-y-3 p-5"><h2 className="font-semibold">{t('stages')}</h2><ol className="list-inside list-decimal space-y-3">{row.stages.map((stage, i) => <li key={i}>{row.routingVersion !== 1 ? t('stageNumber', { number: i + 1 }) : stage.name} — <AttendanceWorkflowStageDescription stage={stage} manager={t('manager')} hr={t('hr')} or={t('or')} sequential={t('v3.sequential')} anyOne={t('v3.anyOne')} allRequired={t('v4.allRequired')} depth={number => t('v3.depthOption', { number })} selectedName={id => { const employee = (options.approverEmployees ?? options.employees).find(row => row.id === id); return employee ? [employee.employeeCode, employee.name].filter(Boolean).join(' · ') : t('unavailable', { value: id }); }}/></li>)}</ol><p className="text-sm text-muted-foreground">{t(row.routingVersion === 3 || row.routingVersion === 4 ? 'v3.levelHelp' : 'supportedApprovers')}</p><p className="text-sm text-muted-foreground">{t(row.routingVersion === 3 || row.routingVersion === 4 ? 'v4.conversionHelp' : 'alternativeHelp')}</p></Card>{!row.retiredAt&&<Card className="space-y-3 p-5" id="workflow-preview">{notice==='saved'&&<p role="status" className="rounded-lg border border-border bg-muted p-3 text-sm">{p('savedHint')}</p>}<h2 className="font-semibold">{p('latestTitle')}</h2>{latest ? <><p className="text-sm">{p('summary', { date: generatedAt!, version: latest.templateVersion, total: latest.totalMatching, warnings: latest.warningCount })}</p>{latest.templateVersion < row.version && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{p('olderVersion', { previewVersion: latest.templateVersion, currentVersion: row.version })}</p>}</> : <p className="text-sm text-muted-foreground">{p('none')}</p>}<div className="flex flex-wrap items-start gap-3"><GeneratePreviewButton lineageId={lineageId} version={row.version}/>{latest && <Link className="min-h-11 py-2 text-primary underline" href={previewHistoryHref(lineageId, latest.id)}>{p('open')}</Link>}</div></Card>}</div>;
}
