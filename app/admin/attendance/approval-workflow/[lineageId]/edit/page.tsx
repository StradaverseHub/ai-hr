import {attendanceWorkflowSelectedEmployees,attendanceWorkflowConfiguration} from '@/lib/attendance-workflow-config';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions, getAttendanceWorkflow } from '@/packs/attendance/service';
import { PageHeader, pageWideCls } from '@/components/ui';
import { attendanceWorkflowCompanyOptions } from '../../company-labels';
import { isWorkflowId } from '../../navigation';
import { WorkflowForm } from '../../workflow-form';
export default async function EditAttendanceWorkflowPage({ params }: {
    params: Promise<{
        lineageId: string;
    }>;
}) {
    const { s, scopeIds,allowedCompanyIds } = await scopedAdmin(), { lineageId } = await params, t = await getTranslations('attendanceWorkflow');
    if (!isWorkflowId(lineageId)) notFound();
    const allowed = allowedCompanyIds ?? scopeIds;
    const row = await getAttendanceWorkflow(s, lineageId, allowed);
    if (!row)
        notFound();
    const permitted = new Set(allowed);
    const assigned = (row.companyIds?.length ? row.companyIds : [row.companyId])
        .filter(companyId => permitted.has(companyId));
    const deferAssignmentOptions = !row.allCompanies && assigned.length > 0 && assigned.length < allowed.length;
    const [options, companyOptions] = await Promise.all([
        attendanceApplicationFilterOptions(s, deferAssignmentOptions ? assigned : allowed, attendanceWorkflowSelectedEmployees(row.stages)),
        deferAssignmentOptions ? attendanceWorkflowCompanyOptions(s, allowed) : undefined,
    ]);
    return <div className={pageWideCls}><PageHeader title={t('editTitle', { name: row.name })} description={t('newVersionHelp')} back={{ href: `/admin/attendance/approval-workflow/${lineageId}`, label: t('back') }}/><WorkflowForm key={lineageId} context={{ companyId: row.companyId, applicationType: row.applicationType }} initial={attendanceWorkflowConfiguration(row)} lineageId={lineageId} options={{ ...options, ...companyOptions }} deferAssignmentOptions={deferAssignmentOptions} assignmentOptionsCompanyIds={deferAssignmentOptions ? assigned : undefined}/></div>;
}
