import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { attendanceApplicationFilterOptions } from '@/packs/attendance/service';
import { PageHeader, pageWideCls } from '@/components/ui';
import { WorkflowForm } from '../workflow-form';
export default async function NewAttendanceWorkflowPage() {
    const { s, scopeIds } = await scopedAdmin(), t = await getTranslations('attendanceWorkflow');
    const options = await attendanceApplicationFilterOptions(s, scopeIds);
    return <div className={pageWideCls}><PageHeader title={t('create')} description={t('newVersionHelp')} back={{ href: '/admin/attendance/approval-workflow', label: t('back') }}/><WorkflowForm initial={null} lineageId={null} options={options}/></div>;
}
