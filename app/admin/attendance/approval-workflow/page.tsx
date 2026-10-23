import Link from 'next/link';
import {WorkflowRetirementControls} from './retirement-controls';
import { AttendanceWorkflowStageDescription } from '@/components/attendance-workflow-stage-description';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listAttendanceWorkflows, listRetiredAttendanceWorkflows, listAttendanceWorkflowSettings, attendanceApplicationFilterOptions } from '@/packs/attendance/service';
import { PageHeader, Card, pageWideCls, tableWrapCls, tbodyCls, thCls } from '@/components/ui';
import { attendanceWorkflowCriteriaFields } from '@/lib/attendance-workflow';
import { approversOf } from '@/lib/leave-approval-kinds';
import { ATTENDANCE_APPLICATION_TYPES } from '@/lib/attendance-workflow';
import { RoutingSwitch } from './workflow-form';
import { companyWorkflowHref, workflowContext, workflowRoot, type WorkflowQuery } from './navigation';
export default async function AttendanceWorkflowPage({ searchParams }: { searchParams: Promise<WorkflowQuery> }) {
  const { s, scopeIds } = await scopedAdmin(), t = await getTranslations('attendanceWorkflow');
  const query=await searchParams;
  let context;
  try { context = workflowContext(query, scopeIds); } catch { notFound(); }
  const ids = context ? [context.companyId] : scopeIds;
  const [rows, settings, options,retiredRows] = await Promise.all([listAttendanceWorkflows(s, ids), listAttendanceWorkflowSettings(s, ids), attendanceApplicationFilterOptions(s, ids),listRetiredAttendanceWorkflows(s,ids)]);
  if (!context) return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={t('companyHelp')} back={{ href: '/admin/attendance/settings', label: t('backSettings') }}/>
    <div className={tableWrapCls}><table className="w-full text-sm"><thead className="bg-background text-left text-xs uppercase text-muted-foreground"><tr>{['company', 'workflowCount', 'actions'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead>
      <tbody className={tbodyCls}>{options.companies.map(company => <tr key={company.id}>
        <td className="p-4 font-medium">{company.name}</td><td className="p-4">{rows.filter(row => row.companyId === company.id).length}</td>
        <td className="p-4"><Link className="text-primary underline underline-offset-2" aria-label={`${t('viewEdit')} ${company.name}`} href={companyWorkflowHref(company.id, 'irregularity')}>{t('viewEdit')}</Link></td>
      </tr>)}</tbody></table>{!options.companies.length && <p className="p-5 text-muted-foreground">{t('noCompanies')}</p>}</div>
  </div>;
  const { companyId, applicationType } = context;
  const company = options.companies.find(company => company.id === companyId);
  if (!company) notFound();
  const workflows = rows.filter(row => row.applicationType === applicationType);
  const enabled = settings.some(setting => setting.companyId === companyId && setting.applicationType === applicationType && setting.enabled);
  const employmentTypeLabel = await getTranslations('people.wizard.employmentType');
  const fields = attendanceWorkflowCriteriaFields(options, employmentTypeLabel);
  return <div className={pageWideCls}>
    <PageHeader title={company.name} description={t('title')} back={{ href: workflowRoot, label: t('backCompanies') }}/>
    <nav aria-label={t('applicationType')} className="flex flex-wrap gap-2 border-b border-border pb-3">{ATTENDANCE_APPLICATION_TYPES.map(type => <Link key={type} href={companyWorkflowHref(companyId, type)} aria-current={applicationType === type ? 'page' : undefined} className={`rounded-md px-4 py-2 text-sm font-medium ${applicationType === type ? 'bg-primary text-primary-foreground' : 'border border-border bg-card hover:bg-muted'}`}>{t(`types.${type}`)}</Link>)}</nav>
    {query.notice==='deleted'&&<p role="status" className="text-sm">{t('v4.deleted')}</p>}
    <section aria-label={t(`types.${applicationType}`)} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t(`types.${applicationType}`)}</h2><Link className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" href={companyWorkflowHref(companyId, applicationType, true)}>{t('create')}</Link></div>
      <Card className="space-y-2 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">{enabled ? t('routingEnabled') : t('legacyRouting')}</h3><RoutingSwitch companyId={companyId} type={applicationType} enabled={enabled}/></div><p className="text-sm text-muted-foreground">{t('routingHelp')}</p></Card>
      <div className={tableWrapCls}><table className="w-full text-sm"><thead className="bg-background text-left text-xs uppercase text-muted-foreground"><tr>{['code', 'name', 'assignment', 'stages', 'priority', 'status', 'actions'].map(k => <th className={thCls} key={k}>{t(k)}</th>)}</tr></thead><tbody className={tbodyCls}>{workflows.map(row => <tr key={row.id}>
        <td className="p-3 font-mono">{row.code}</td><td className="p-3">{row.name}</td>
        <td className="min-w-48 p-3">{fields.some(({key}) => row.criteria[key]?.length) ? <ul className="space-y-1">{fields.filter(({key}) => row.criteria[key]?.length).map(({key, label, options:items}) => <li key={key}><span className="font-medium">{t(label)}: </span>{row.criteria[key]!.map(id => items.find(item => item.id === id)?.name ?? t('unavailable', { value: id })).join(', ')}</li>)}</ul> : t('all')}</td>
        <td className="min-w-56 p-3"><ol className="list-inside list-decimal space-y-2">{row.stages.map((stage, index) => <li key={index}><span className="font-medium">{row.routingVersion !== 1 ? t('stageNumber', { number: index + 1 }) : stage.name}</span><div className="text-muted-foreground"><AttendanceWorkflowStageDescription stage={stage} manager={t('manager')} hr={t('hr')} or={t('or')} sequential={t('v3.sequential')} anyOne={t('v3.anyOne')} allRequired={t('v4.allRequired')} depth={number => t('v3.depthOption', { number })} selectedName={id => { const employee = (options.approverEmployees ?? options.employees).find(row => row.id === id); return employee ? [employee.employeeCode, employee.name].filter(Boolean).join(' · ') : t('unavailable', { value: id }); }}/></div></li>)}</ol></td>
        <td className="p-3">{row.priority}</td><td className="p-3">{row.active ? t('active') : t('inactive')}</td>
        <td className="p-3"><div className="flex gap-3"><Link className="text-primary underline" href={`${workflowRoot}/${row.lineageId}`}>{t('view')}</Link><Link className="text-primary underline" href={`${workflowRoot}/${row.lineageId}/edit`}>{t('edit')}</Link><WorkflowRetirementControls lineageId={row.lineageId} version={row.version} name={row.name} company={company.name}/></div></td>
      </tr>)}</tbody></table>{!workflows.length && <p className="p-5 text-muted-foreground">{t('empty')}</p>}</div>
      {retiredRows.some(row=>row.applicationType===applicationType)&&<details className="border-t border-border pt-4"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{t('v4.retained')}</summary><ul className="divide-y divide-border">{retiredRows.filter(row=>row.applicationType===applicationType).map(row=><li key={row.id} className="flex flex-wrap justify-between gap-3 py-3 text-sm"><Link className="text-primary underline" href={`${workflowRoot}/${row.lineageId}`}>{row.code} · {row.name}</Link><WorkflowRetirementControls retired lineageId={row.lineageId} version={row.version} name={row.name} company={company.name}/></li>)}</ul></details>}
    </section>
  </div>;
}
