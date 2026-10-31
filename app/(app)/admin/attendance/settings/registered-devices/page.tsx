import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { allowedCompanies } from '@/core/read';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { PageHeader, ErrorBanner, pageWideCls } from '@/components/ui';
import { RegisteredDevicesCard } from '../../../attendance-policy/registered-devices-card';
export default async function SettingsDestination({searchParams}:{searchParams:Promise<{error?:string}>}) {
 const {s,scopeIds}=await scopedAdmin(),t=await getTranslations('attendanceSettingsHub'),sp=await searchParams;
 const companies=(await allowedCompanies(s)).filter(c=>scopeIds.includes(c.id));
 return <div className={pageWideCls}><AttendanceSettingsNavigation/><PageHeader title={t('registeredDevices.title')} description={t('registeredDevices.desc')} back={{href:'/admin/attendance/settings',label:t('backToSettings')}}/><ErrorBanner message={sp.error}/><RegisteredDevicesCard s={s} companies={companies}/></div>;
}
