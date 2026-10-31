import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { allowedCompanies } from '@/core/read';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { PageHeader, ErrorBanner, pageWideCls } from '@/components/ui';
import { listAttendancePolicies } from '@/core/attendance';
import { CompanyPolicyCard,CompanyPolicyEditPanel,CompanyPolicyViewPanel } from '../../../attendance-policy/company-policy-card';
import { policyLastUpdated } from '../../../attendance-policy/policy-last-updated';
import { resolveSchedulePanel, SCHEDULE_PANEL_ANCHOR } from '../../../attendance-policy/schedule-panel';
export default async function CompanyPolicies({searchParams}:{searchParams:Promise<{error?:string;policy?:string;viewPolicy?:string}>}) {
 const {s,scopeIds}=await scopedAdmin(),t=await getTranslations('attendanceSettingsHub'),sp=await searchParams;
 const companies=(await allowedCompanies(s)).filter(c=>scopeIds.includes(c.id)),ids=companies.map(c=>c.id);
 const [policies,lastUpdated]=await Promise.all([listAttendancePolicies(s,ids),policyLastUpdated(s,ids)]);
 const panel=resolveSchedulePanel(sp,ids),company=companies.find(c=>c.id===panel?.companyId),policy=policies.find(c=>c.companyId===company?.id);
 return <div className={pageWideCls}><AttendanceSettingsNavigation/><PageHeader title={t('companyPolicy.title')} description={t('companyPolicy.desc')} back={{href:'/admin/attendance/settings',label:t('backToSettings')}}/>
 {!panel&&<ErrorBanner message={sp.error}/>}
 <CompanyPolicyCard companies={companies} policies={policies} lastUpdated={lastUpdated}/>
 {panel&&company&&policy&&<section id={SCHEDULE_PANEL_ANCHOR} className="scroll-mt-6">{panel.kind==='policy-edit'?<CompanyPolicyEditPanel company={company} policy={policy} error={sp.error}/>:<CompanyPolicyViewPanel company={company} policy={policy} error={sp.error}/>}</section>}
 </div>;
}
