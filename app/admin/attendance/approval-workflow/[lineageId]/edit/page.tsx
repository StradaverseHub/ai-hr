import {attendanceWorkflowConfiguration} from '@/lib/attendance-workflow-config';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions, getAttendanceWorkflow } from '@/packs/attendance/service';
import { PageHeader, pageWideCls } from '@/components/ui';
import { isWorkflowId } from '../../navigation';
import { WorkflowForm } from '../../workflow-form';
export default async function EditAttendanceWorkflowPage({ params }: {
    params: Promise<{
        lineageId: string;
    }>;
}) {
    const { s, scopeIds } = await scopedAdmin(), { lineageId } = await params, t = await getTranslations('attendanceWorkflow');
    if (!isWorkflowId(lineageId)) notFound();
    const row = await getAttendanceWorkflow(s, lineageId, scopeIds);
    if (!row)
        notFound();
    const options = await attendanceApplicationFilterOptions(s, [row.companyId]);
    return <div className={pageWideCls}><PageHeader title={t('editTitle', { name: row.name })} description={t('newVersionHelp')} back={{ href: `/admin/attendance/approval-workflow/${lineageId}`, label: t('back') }}/><WorkflowForm key={lineageId} context={{ companyId: row.companyId, applicationType: row.applicationType }} initial={attendanceWorkflowConfiguration(row)} lineageId={lineageId} options={options}/></div>;
}
