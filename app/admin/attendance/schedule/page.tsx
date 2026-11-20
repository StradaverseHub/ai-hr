import {getLocale,getTranslations} from 'next-intl/server';
import {redirect} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {listAttendanceRules} from '@/core/attendance-rule';
import {AttendanceSettingsNavigation} from '@/components/attendance-settings-navigation';
import {LegacyScheduleAnchor} from '@/components/legacy-schedule-anchor';
import {ErrorBanner,PageHeader,btnPrimary,pageWideCls} from '@/components/ui';
import {ActionButton} from '@/components/ui/action-button';
import {ScheduleGroupCard} from '../../attendance-policy/schedule-group-card';
import {COMPANY_POLICY} from '../../attendance-policy/schedule-panel';
import {initializeStandardSchedule} from './initialize-standard';

const standardSetupLabel:Record<string,string>={
 en:'Set up the Standard Schedule Group',
 ms:'Sediakan Kumpulan Jadual Standard',
 zh:'设置标准排班组',
 ta:'நிலையான அட்டவணைக் குழுவை அமைக்கவும்',
 th:'ตั้งค่ากลุ่มตารางงานมาตรฐาน',
 vi:'Thiết lập Nhóm lịch làm việc tiêu chuẩn',
};

/** Schedule owns the group list. */
export default async function ScheduleListPage({searchParams}:{searchParams:Promise<{error?:string;toast?:string;policy?:string;viewPolicy?:string}>}) {
 const s=await requireAdmin(),t=await getTranslations('admin.scheduleConfig'),hub=await getTranslations('attendanceSettingsHub'),sp=await searchParams;
 if(sp.policy||sp.viewPolicy){
  const q=new URLSearchParams();
  for(const key of ['policy','viewPolicy','error','toast'] as const)if(typeof sp[key]==='string')q.set(key,sp[key]!);
  redirect(COMPANY_POLICY+'?'+q.toString()+'#schedule-panel');
 }
 const rules=await listAttendanceRules(s);
 const needsStandard=!rules.some(rule=>rule.isDefault);
 return <div className={pageWideCls}>
  <LegacyScheduleAnchor/>
  <AttendanceSettingsNavigation/>
  <PageHeader title={t('pageTitle')} description={t('listSubtitle')} back={{href:'/admin/attendance/settings',label:hub('backToSettings')}}/>
  <ErrorBanner message={sp.error}/>
  {needsStandard&&<form action={initializeStandardSchedule}>
   <ActionButton type="submit" actionKind="saving" className={btnPrimary}>
    {standardSetupLabel[await getLocale()]??standardSetupLabel.en}
   </ActionButton>
  </form>}
  <ScheduleGroupCard rules={rules}/>
 </div>;
}
