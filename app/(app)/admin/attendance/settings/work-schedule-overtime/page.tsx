import { ShiftPaySettings } from '../../../attendance-policy/shift-pay-settings';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { allowedCompanies } from '@/core/read';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { PageHeader, ErrorBanner, pageWideCls } from '@/components/ui';
import { WorkScheduleOvertimeCard } from '../../../attendance-policy/work-schedule-overtime-card';
export default async function SettingsDestination({searchParams}:{searchParams:Promise<{error?:string}>}) {
 const {s,scopeIds}=await scopedAdmin(),t=await getTranslations('attendanceSettingsHub'),sp=await searchParams;
 const companies=(await allowedCompanies(s)).filter(c=>scopeIds.includes(c.id));
 return <div className={pageWideCls}><AttendanceSettingsNavigation/><PageHeader title={t('workScheduleOvertime.title')} description={t('workScheduleOvertime.desc')} back={{href:'/admin/attendance/settings',label:t('backToSettings')}}/><ErrorBanner message={sp.error}/><WorkScheduleOvertimeCard s={s} companies={companies}/><ShiftPaySettings s={s}/></div>;
}
