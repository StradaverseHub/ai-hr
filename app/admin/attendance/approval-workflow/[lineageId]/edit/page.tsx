import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions, getAttendanceWorkflow } from '@/packs/attendance/service';
import { PageHeader, pageWideCls } from '@/components/ui';
import { WorkflowForm } from '../../workflow-form';
export default async function EditAttendanceWorkflowPage({ params }: {
    params: Promise<{
        lineageId: string;
    }>;
}) {
    const { s, scopeIds } = await scopedAdmin(), { lineageId } = await params, t = await getTranslations('attendanceWorkflow');
    const [row, options] = await Promise.all([getAttendanceWorkflow(s, lineageId, scopeIds), attendanceApplicationFilterOptions(s, scopeIds)]);
    if (!row)
        notFound();
    return <div className={pageWideCls}><PageHeader title={t('editTitle', { name: row.name })} description={t('newVersionHelp')} back={{ href: `/admin/attendance/approval-workflow/${lineageId}`, label: t('back') }}/><WorkflowForm initial={{ ...row, description: row.description ?? '' }} lineageId={lineageId} options={options}/></div>;
}
