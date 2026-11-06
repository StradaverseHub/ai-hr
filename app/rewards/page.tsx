import {rewardReviewCompanyGroups,rewardWholeGroupPlans} from '@/packs/rewards/group-roles';
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
 const companies=await rewardVisibleCompanies(s),allowedIds=companies.map(c=>c.id),scopeIds=companies.some(c=>c.wholeGroup)?allowedIds:await getScopeIds(allowedIds);
 const t=await getTranslations('rewards'), nav=await getTranslations('nav'), sp=await searchParams;
 const [list,choices,destinations,plans,companyGroups]=await Promise.all([
   listRewardReviewStatus(s,scopeIds),rewardSetupChoices(s,scopeIds),rewardNavigation(s,isAdmin(s)),rewardWholeGroupPlans(s),rewardReviewCompanyGroups(s,scopeIds),
 ]);
 const setup=await getTranslations('rewardSetup');
 return <div className="w-full space-y-6"><PageHeader title={nav('rewardsReviewing')} description={t('description')} actions={<>
  {list.rows.some(row => row.kind === 'annual' && row.roles.length > 0) && <Link href="/rewards/promotions" className="inline-flex text-sm font-medium text-primary hover:underline">{t('promotionNominations')}</Link>}
  {destinations.includes('/rewards/analytics') && <Link href="/rewards/analytics" className="inline-flex text-sm font-medium text-primary hover:underline">{nav('rewardsAnalytics')}</Link>}
  {destinations.includes('/rewards/approvals') && <Link href="/rewards/approvals" className="inline-flex text-sm font-medium text-primary hover:underline">{nav('rewardsApprovalsBoard')}</Link>}
  {destinations.includes('/rewards/rules') && <Link href="/rewards/rules" className="inline-flex text-sm font-medium text-primary hover:underline">{nav('rewardsRules')}</Link>}
 </>}/><ErrorBanner message={sp.error}/>
  {plans.length>0&&<details className="rounded-lg border border-border p-4">
    <summary className="cursor-pointer font-medium">{setup('plans')} ({plans.length})</summary>
    <ul className="mt-3 divide-y divide-border">
      {plans.map(plan=><li key={plan.id} className="space-y-1 py-3 text-sm">
        <p className="font-medium">{plan.cycle} · {plan.year}</p>
        <p>{t('stage')}: {setup(plan.state)} · {setup('snapshotDate')}: {plan.snapshot}</p>
        <p className="text-muted-foreground">{plan.companies.join(' · ')}</p>
      </li>)}
    </ul>
  </details>}
  <RewardReviewList {...list} overview canOpenApprovals={destinations.includes('/rewards/approvals')} companyGroups={companyGroups} filters={sp} canConfigure={choices.companies.length>0}/></div>;
}
