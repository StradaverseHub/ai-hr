import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedSession,getScopeIds} from '@/lib/scope';
import {isAdmin,requireModule} from '@/lib/authz';
import {rewardNavigation,rewardVisibleCompanies} from '@/packs/rewards/access-policy';
import {rewardDashboard,getRewardDashboardPreference} from '@/packs/rewards/service';
import {ErrorBanner,PageHeader} from '@/components/ui';
import {redirect} from 'next/navigation';
import {RewardsDashboard} from './dashboard';
import type {RewardReviewFilters} from '@/packs/rewards/review-list-model';
export default async function RewardsPage({searchParams}:{searchParams:Promise<RewardReviewFilters&{error?:string}>}){
 await requireModule('rewards');const {s}=await scopedSession(),sp=await searchParams;
 // Keep saved and incoming review-list links useful at their dedicated destination.
 if(['cycle','company','unit','businessGroup','stage','waiting'].some(key=>sp[key as keyof RewardReviewFilters])){
  const query=new URLSearchParams(Object.entries(sp).filter(([,v])=>typeof v==='string') as [string,string][]);redirect(`/rewards/reviews?${query}`);
 }
 const companies=await rewardVisibleCompanies(s),allowedIds=companies.map(c=>c.id),scopeIds=companies.some(c=>c.wholeGroup)?allowedIds:await getScopeIds(allowedIds);
 const [preference,destinations,t,nav]=await Promise.all([getRewardDashboardPreference(s),rewardNavigation(s,isAdmin(s)),getTranslations('rewardDashboard'),getTranslations('nav')]);
 const value=await rewardDashboard(s,scopeIds,preference);
 return <div className="w-full space-y-5"><PageHeader title={t('greeting')} description={nav('rewardsReviewing')} actions={<nav aria-label={t('destinations')} className="flex flex-wrap gap-4 text-sm text-primary"><Link className="hover:underline" href="/rewards/reviews">{t('allReviews')}</Link>{destinations.filter(href=>['/rewards/analytics','/rewards/approvals','/rewards/rules'].includes(href)).map(href=><Link key={href} className="hover:underline" href={href}>{nav(href.endsWith('analytics')?'rewardsAnalytics':href.endsWith('approvals')?'rewardsApprovalsBoard':'rewardsRules')}</Link>)}</nav>}/><ErrorBanner message={sp.error}/><RewardsDashboard value={value}/></div>;
}
