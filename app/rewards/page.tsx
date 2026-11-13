import {getTranslations} from 'next-intl/server';
import {scopedSession,getScopeIds} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {rewardVisibleCompanies} from '@/packs/rewards/access-policy';
import {rewardDashboard,getRewardDashboardPreference,rewardOffcycleDashboard} from '@/packs/rewards/service';
import {decodeRewardDashboardPreference} from '@/packs/rewards/dashboard-model';
import {ErrorBanner,PageHeader} from '@/components/ui';
import {redirect} from 'next/navigation';
import {RewardsDashboard} from './dashboard';
import {RewardsDashboardKindSwitch} from './dashboard-kind-switch';
import {RewardsOffcycleDashboard} from './offcycle-dashboard';
import type {RewardReviewFilters} from '@/packs/rewards/review-list-model';
export default async function RewardsPage({searchParams}:{searchParams:Promise<RewardReviewFilters&{error?:string}>}){
 await requireModule('rewards');const {s}=await scopedSession(),sp=await searchParams;
 // Keep saved and incoming review-list links useful at their dedicated destination.
 if(['plan','cycle','company','unit','businessGroup','stage','waiting'].some(key=>sp[key as keyof RewardReviewFilters])){
  const query=new URLSearchParams(Object.entries(sp).filter(([,v])=>typeof v==='string') as [string,string][]);redirect(`/rewards/reviews?${query}`);
 }
 const companies=await rewardVisibleCompanies(s),allowedIds=companies.map(c=>c.id),scopeIds=companies.some(c=>c.wholeGroup)?allowedIds:await getScopeIds(allowedIds);
 const [preference,t,nav]=await Promise.all([getRewardDashboardPreference(s),getTranslations('rewardDashboard'),getTranslations('nav')]);
 // b945f0cc: Year-end cycle / Off-cycle switch; the saved preference keeps the last choice.
 const kind=decodeRewardDashboardPreference(preference).kind;
 const offcycle=kind==='offcycle'?await rewardOffcycleDashboard(s,scopeIds):null;
 const value=offcycle?null:await rewardDashboard(s,scopeIds,preference);
 return <div className="w-full space-y-5"><PageHeader title={nav('rewardsReviewing')} description={t('purpose')}/><ErrorBanner message={sp.error}/>
  <RewardsDashboardKindSwitch kind={kind}/>
  {offcycle?<RewardsOffcycleDashboard value={offcycle}/>:value&&<RewardsDashboard value={value}/>}</div>;
}
