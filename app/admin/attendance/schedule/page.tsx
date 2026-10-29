import {getTranslations} from 'next-intl/server';
import {redirect} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {ensureStandardRule,listAttendanceRules} from '@/core/attendance-rule';
import {AttendanceSettingsNavigation} from '@/components/attendance-settings-navigation';
import {LegacyScheduleAnchor} from '@/components/legacy-schedule-anchor';
import {ErrorBanner,PageHeader,pageWideCls} from '@/components/ui';
import {ScheduleGroupCard} from '../../attendance-policy/schedule-group-card';
import {COMPANY_POLICY} from '../../attendance-policy/schedule-panel';
import {OfflineClockingCard} from '../../attendance-policy/offline-clocking-card';
import {loadOfflineClockingSettings} from '../../attendance-policy/offline-clocking-data';

/** Schedule owns the group list. Each other setting now has a single destination; the company "Offline clocking"
 * card sits beside the group card here, where the approved design places it (draft 0647, owner decision 2026-10-28). */
export default async function ScheduleListPage({searchParams}:{searchParams:Promise<{error?:string;toast?:string;policy?:string;viewPolicy?:string}>}) {
 const s=await requireAdmin(),t=await getTranslations('admin.scheduleConfig'),hub=await getTranslations('attendanceSettingsHub'),sp=await searchParams;
 if(sp.policy||sp.viewPolicy){
  const q=new URLSearchParams();
  for(const key of ['policy','viewPolicy','error','toast'] as const)if(typeof sp[key]==='string')q.set(key,sp[key]!);
  redirect(COMPANY_POLICY+'?'+q.toString()+'#schedule-panel');
 }
 await ensureStandardRule(s);
 const [rules,offline]=await Promise.all([listAttendanceRules(s),loadOfflineClockingSettings(s)]);
 return <div className={pageWideCls}><LegacyScheduleAnchor/><AttendanceSettingsNavigation/><PageHeader title={t('pageTitle')} description={t('listSubtitle')} back={{href:'/admin/attendance/settings',label:hub('backToSettings')}}/><ErrorBanner message={sp.error}/><ScheduleGroupCard rules={rules}/><OfflineClockingCard companies={offline}/></div>;
}
