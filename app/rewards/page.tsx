import {rewardNavigation,rewardVisibleCompanies} from '@/packs/rewards/access-policy';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedSession,getScopeIds} from '@/lib/scope';
import {isAdmin,requireModule} from '@/lib/authz';
import {listRewardReviewStatus,rewardSetupChoices} from '@/packs/rewards/service';
import {ErrorBanner,PageHeader} from '@/components/ui';
import type {RewardReviewFilters} from '@/packs/rewards/review-list-model';
import {RewardReviewList} from './review-list';
export default async function RewardsPage({searchParams}:{searchParams:Promise<RewardReviewFilters&{error?:string}>}){
 await requireModule('rewards');
 const {s}=await scopedSession();
 const scopeIds=await getScopeIds((await rewardVisibleCompanies(s)).map(c=>c.id));
 const t=await getTranslations('rewards'), nav=await getTranslations('nav'), sp=await searchParams;
 const [list,choices,destinations]=await Promise.all([listRewardReviewStatus(s,scopeIds),rewardSetupChoices(s,scopeIds),rewardNavigation(s,isAdmin(s))]);
 return <div className="w-full space-y-6"><PageHeader title={nav('rewardsReviewing')} description={t('description')} actions={<>
  {destinations.includes('/rewards/analytics') && <Link href="/rewards/analytics" className="inline-flex text-sm font-medium text-primary hover:underline">{nav('rewardsAnalytics')}</Link>}
  {destinations.includes('/rewards/approvals') && <Link href="/rewards/approvals" className="inline-flex text-sm font-medium text-primary hover:underline">{nav('rewardsApprovalsBoard')}</Link>}
  {destinations.includes('/rewards/rules') && <Link href="/rewards/rules" className="inline-flex text-sm font-medium text-primary hover:underline">{nav('rewardsRules')}</Link>}
 </>}/><ErrorBanner message={sp.error}/><RewardReviewList {...list} filters={sp} canConfigure={choices.companies.length>0}/></div>;
}
