import { nextAttendanceWorkflowPriority } from '@/lib/attendance-workflow';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions, getAttendanceWorkflow, listAttendanceWorkflows } from '@/packs/attendance/service';
import { attendanceWorkflowConfiguration, attendanceWorkflowSelectedEmployees } from '@/lib/attendance-workflow-config';
import { PageHeader, pageWideCls } from '@/components/ui';
import { WorkflowForm } from '../workflow-form';
import { companyWorkflowHref, isWorkflowId, workflowContext, workflowRoot, type WorkflowQuery } from '../navigation';
export default async function NewAttendanceWorkflowPage({ searchParams }: { searchParams: Promise<WorkflowQuery> }) {
  const { s, scopeIds,allowedCompanyIds } = await scopedAdmin(), t = await getTranslations('attendanceWorkflow');
  let context:ReturnType<typeof workflowContext>;
  const query=await searchParams;
  if(query.copyFrom!==undefined)return copyWorkflowPage(query);
  if(query.companyId!==undefined&&typeof query.companyId!=='string')notFound();
  const applicationType=query.applicationType??'irregularity';
  if(applicationType!=='irregularity'&&applicationType!=='self_overtime')notFound();
  try { context = typeof query.companyId==='string'?workflowContext({...query,applicationType}, allowedCompanyIds??scopeIds):scopeIds[0]?{companyId:scopeIds[0],applicationType}:null; } catch { notFound(); }
  if (!context) redirect(workflowRoot);
  const [options, workflows] = await Promise.all([
    attendanceApplicationFilterOptions(s, allowedCompanyIds??scopeIds),
    listAttendanceWorkflows(s, [context.companyId]),
  ]);
  const defaultPriority = nextAttendanceWorkflowPriority(workflows
    .filter(workflow => workflow.applicationType === context.applicationType)
    .map(workflow => workflow.priority));
  if (!options.companies.some(company => company.id === context.companyId)) notFound();
  return <div className={pageWideCls}><PageHeader title={t('create')} description={t('newVersionHelp')} back={{ href: companyWorkflowHref(context.companyId, context.applicationType), label: t('back') }}/><WorkflowForm key={`${context.companyId}:${context.applicationType}`} initial={null} defaultPriority={Math.min(defaultPriority, 9999)} lineageId={null} context={context} options={options}/></div>;
}

/** Copy Workflow: Create Workflow prefilled from a workflow the administrator manages; code, name and description are blank. */
async function copyWorkflowPage(query:WorkflowQuery){
  const { s, scopeIds, allowedCompanyIds } = await scopedAdmin(), t = await getTranslations('attendanceWorkflow');
  if(typeof query.copyFrom!=='string'||!isWorkflowId(query.copyFrom))notFound();
  const source=await getAttendanceWorkflow(s,query.copyFrom,allowedCompanyIds??scopeIds);
  if(!source||(query.applicationType!==undefined&&query.applicationType!==source.applicationType))notFound();
  const {expectedVersion:_version,...configuration}=attendanceWorkflowConfiguration(source);
  const initial={...configuration,code:'',name:'',description:''};
  const options=await attendanceApplicationFilterOptions(s,allowedCompanyIds??scopeIds,attendanceWorkflowSelectedEmployees(source.stages));
  return <div className={pageWideCls}><PageHeader title={t('create')} description={t('copy.help')} back={{ href: companyWorkflowHref(source.companyId, source.applicationType), label: t('back') }}/><WorkflowForm key={`copy:${source.lineageId}:${source.version}`} initial={initial} lineageId={null} context={{companyId:source.companyId,applicationType:source.applicationType}} options={options} copiedFrom={{lineageId:source.lineageId,version:source.version,code:source.code}}/></div>;
}
