import {rewardAccessPageCompanies} from '@/packs/rewards/access-policy';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {rewardAccessCompanies,listRewardReviewStatus,rewardSetupChoices} from '@/packs/rewards/service';
import {ErrorBanner,PageHeader} from '@/components/ui';
import type {RewardReviewFilters} from '@/packs/rewards/review-list-model';
import {RewardReviewList} from './review-list';
export default async function RewardsPage({searchParams}:{searchParams:Promise<RewardReviewFilters&{error?:string}>}){
 await requireModule('rewards');const {s,scopeIds}=await scopedSession(),t=await getTranslations('rewards'),sp=await searchParams;
 const [list,choices]=await Promise.all([listRewardReviewStatus(s,scopeIds),rewardSetupChoices(s,scopeIds)]),canConfigure=choices.companies.length>0,accessScopes=await rewardAccessPageCompanies(s).catch(()=>[]);
 return <div className="w-full space-y-6"><PageHeader title={t('title')} description={t('description')} actions={<>
  <Link href="/admin/rewards/uploaded" className="inline-flex text-sm font-medium text-primary hover:underline">{(await getTranslations('rewardUploaded'))('createTitle')}</Link>
  <Link href="/rewards/analytics" className="inline-flex text-sm font-medium text-primary hover:underline">{(await getTranslations('rewardAdvisor'))('analytics')}</Link>
  <Link href="/rewards/rules" className="inline-flex text-sm font-medium text-primary hover:underline">{t('rules')}</Link>
  <Link href="/rewards/approvals" className="inline-flex text-sm font-medium text-primary hover:underline">{t('board.open')}</Link>
  {accessScopes.length>0&&<Link href="/admin/rewards/access" className="inline-flex text-sm font-medium text-primary hover:underline">{(await getTranslations('rewardsAccess'))('title')}</Link>}
  {canConfigure&&<Link href="/admin/rewards" className="inline-flex text-sm font-medium text-primary hover:underline">{t('adminTitle')}</Link>}
 </>}/><ErrorBanner message={sp.error}/><RewardReviewList {...list} filters={sp} canConfigure={canConfigure}/></div>;
}
