import {getTranslations} from 'next-intl/server';
import {redirect} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {ensureStandardRule,listAttendanceRules} from '@/core/attendance-rule';
import {AttendanceSettingsNavigation} from '@/components/attendance-settings-navigation';
import {LegacyScheduleAnchor} from '@/components/legacy-schedule-anchor';
import {ErrorBanner,PageHeader,pageWideCls} from '@/components/ui';
import {ScheduleGroupCard} from '../../attendance-policy/schedule-group-card';
import {COMPANY_POLICY} from '../../attendance-policy/schedule-panel';

/** Schedule owns only the group list. Each other setting now has a single destination. */
export default async function ScheduleListPage({searchParams}:{searchParams:Promise<{error?:string;toast?:string;policy?:string;viewPolicy?:string}>}) {
 const s=await requireAdmin(),t=await getTranslations('admin.scheduleConfig'),hub=await getTranslations('attendanceSettingsHub'),sp=await searchParams;
 if(sp.policy||sp.viewPolicy){
  const q=new URLSearchParams();
  for(const key of ['policy','viewPolicy','error','toast'] as const)if(typeof sp[key]==='string')q.set(key,sp[key]!);
  redirect(COMPANY_POLICY+'?'+q.toString()+'#schedule-panel');
 }
 await ensureStandardRule(s);
 const rules=await listAttendanceRules(s);
 return <div className={pageWideCls}><LegacyScheduleAnchor/><AttendanceSettingsNavigation/><PageHeader title={t('pageTitle')} description={t('listSubtitle')} back={{href:'/admin/attendance/settings',label:hub('backToSettings')}}/><ErrorBanner message={sp.error}/><ScheduleGroupCard rules={rules}/></div>;
}
