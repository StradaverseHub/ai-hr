import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions } from '@/packs/attendance/service';
import { PageHeader, pageWideCls } from '@/components/ui';
import { WorkflowForm } from '../workflow-form';
import { companyWorkflowHref, workflowContext, workflowRoot, type WorkflowQuery } from '../navigation';
export default async function NewAttendanceWorkflowPage({ searchParams }: { searchParams: Promise<WorkflowQuery> }) {
  const { s, scopeIds } = await scopedAdmin(), t = await getTranslations('attendanceWorkflow');
  let context;
  try { context = workflowContext(await searchParams, scopeIds); } catch { notFound(); }
  if (!context) redirect(workflowRoot);
  const options = await attendanceApplicationFilterOptions(s, [context.companyId]);
  if (!options.companies.some(company => company.id === context.companyId)) notFound();
  return <div className={pageWideCls}><PageHeader title={t('create')} description={t('newVersionHelp')} back={{ href: companyWorkflowHref(context.companyId, context.applicationType), label: t('back') }}/><WorkflowForm key={`${context.companyId}:${context.applicationType}`} initial={null} lineageId={null} context={context} options={options}/></div>;
}
